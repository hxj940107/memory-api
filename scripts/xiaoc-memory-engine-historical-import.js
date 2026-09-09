#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

export const SOURCE_SHA = "a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178"
export const MANIFEST_SHA = "861325ac1b3c8b22ce6b4aa124239c66dee08e263bceda43d5bd75930be070db"
export const UUID_NAMESPACE = "f1c7e436-ff13-5d2c-8e4a-5de7386b6db7"
export const EXPECTED_COUNT = 150
export const POLICY_VERSION = "xiaoc-historical-import-v1"
export const IMPORTER_VERSION = "xiaoc-historical-importer-v1"
const UNIT = "\x1f"
const RECORD = "\x1e"

const ORIGINAL_LOW = ["LOW_RISK_DYNAMIC_DOMAIN", "LEGACY_UNVERIFIED", "STRONG_RELEVANCE_REQUIRED"]
const reviewed = (signal) => ["HISTORICAL_CONTINUITY_REVIEW_APPROVED", signal, "NO_HIGH_AUTHORITY_MARKER"]
export const LOW_ALLOWLIST = new Map([
  ["ffb8ce86aa3b", ["0458ba7f6948ed79cf9ac8f6d66fe1270c5c49beab3ea6edf9c0e35be3a15244", ORIGINAL_LOW]],
  ["632959ffb312", ["63409c97c8ce34bdb88f749fcbea405ebd35a928e66ad87d3a138eaad791d7b6", reviewed("EXPLICIT_PAST_FRAMING")]],
  ["8815e2b2c20a", ["66df447a878f179aaccbac98c90bbdd741a6debfb0ae920973f3d68172417a72", reviewed("HISTORICAL_EVENT_SIGNAL")]],
  ["f4c1457bd8d3", ["4b88854ce96d0f4034bbfd18314eabfdd446a45d307ed86c2975735d4c90ffbb", reviewed("HISTORICAL_EVENT_SIGNAL")]],
  ["1d16fc964753", ["54398556b3fa29cb00a29cc1b17dcb3eff72f72a6664b0cf668215255925c1d8", reviewed("EXPLICIT_PAST_FRAMING")]],
  ["b4db8014d06e", ["4f0bbdc4de42a4631d16dcec1bdecf0c7a4c7024e5eb02a37689267f8ea2cafe", reviewed("HISTORICAL_EVENT_SIGNAL")]],
])

const sha256 = (value) => createHash("sha256").update(value).digest("hex")
export const sha256File = (path) => sha256(readFileSync(path))

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex")
}

export function uuidV5(namespace, name) {
  const bytes = createHash("sha1").update(uuidBytes(namespace)).update(Buffer.from(name, "utf8")).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function extractBody(raw) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  if (!lines.length || lines[0].trim() !== "---") throw new Error("FRONTMATTER_MISSING")
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing < 0) throw new Error("FRONTMATTER_UNTERMINATED")
  const body = Buffer.from(lines.slice(closing + 1).join(""), "utf8")
  if (!body.toString("utf8").trim()) throw new Error("CONTENT_EMPTY")
  return body
}

function readArchiveBody(archive, relativePath) {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) throw new Error("UNSAFE_RELATIVE_PATH")
  const member = `ombre-volume-snapshot-2026-09-08/${relativePath}`
  return extractBody(execFileSync("tar", ["-xOf", archive, member], { maxBuffer: 8 * 1024 * 1024 }))
}

function canonicalArchivePaths(archive) {
  const prefix = "ombre-volume-snapshot-2026-09-08/"
  return new Set(execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    .split("\n").filter(Boolean).filter((member) => {
      const relative = member.startsWith(prefix) ? member.slice(prefix.length) : ""
      const parts = relative.split("/")
      return parts.length >= 3 && ["permanent", "dynamic", "feel", "archive"].includes(parts[0])
        && relative.endsWith(".md") && !parts.at(-1).startsWith("._")
    }).map((member) => member.slice(prefix.length)))
}

function dbTextArray(values) {
  return values
}

export function classificationDigest(plan) {
  const value = [...plan].sort((a, b) => Buffer.compare(Buffer.from(a.legacy_external_id), Buffer.from(b.legacy_external_id)))
    .map((item) => [item.legacy_external_id, item.content_hash, item.deterministic_memory_id, item.retrieval_tier, item.authority_tier].join(UNIT)).join(RECORD)
  return sha256(Buffer.from(value, "utf8"))
}

export function executionOrderDigest(plan) {
  const value = [...plan].sort((a, b) => a.ordinal - b.ordinal)
    .map((item) => [String(item.ordinal), item.legacy_external_id, item.content_hash, item.deterministic_memory_id].join(UNIT)).join(RECORD)
  return sha256(Buffer.from(value, "utf8"))
}

export function buildPlan({ archivePath, manifestPath }) {
  if (sha256File(archivePath) !== SOURCE_SHA) throw new Error("SOURCE_SHA_MISMATCH")
  if (sha256File(manifestPath) !== MANIFEST_SHA) throw new Error("MANIFEST_SHA_MISMATCH")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.source_archive_sha256 !== SOURCE_SHA || manifest.entries?.length !== EXPECTED_COUNT) throw new Error("SOURCE_CONTRACT_MISMATCH")
  if (manifest.identity?.user_id !== "user" || manifest.identity?.source_system !== "ombre") throw new Error("IDENTITY_CONTRACT_MISMATCH")

  const sourcePaths = canonicalArchivePaths(archivePath)
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.relative_path))
  const missing = [...manifestPaths].filter((path) => !sourcePaths.has(path)).sort()
  const unexpected = [...sourcePaths].filter((path) => !manifestPaths.has(path)).sort()
  if (missing.length || unexpected.length) throw new Error("ARCHIVE_MANIFEST_COVERAGE_MISMATCH")
  const seenExternal = new Set(), seenMemory = new Set(), seenPaths = new Set()
  const entries = [...manifest.entries].sort((a, b) => Buffer.compare(Buffer.from(a.legacy_external_id), Buffer.from(b.legacy_external_id)))
  const plan = entries.map((entry, ordinal) => {
    if (!/^[0-9a-f]{12}$/.test(entry.legacy_external_id)) throw new Error("INVALID_LEGACY_ID")
    if (seenExternal.has(entry.legacy_external_id) || seenMemory.has(entry.deterministic_memory_id) || seenPaths.has(entry.relative_path)) throw new Error("DUPLICATE_CANONICAL_IDENTITY")
    seenExternal.add(entry.legacy_external_id); seenMemory.add(entry.deterministic_memory_id); seenPaths.add(entry.relative_path)
    const expectedId = uuidV5(UUID_NAMESPACE, ["user", "ombre", entry.legacy_external_id].join(UNIT))
    if (entry.deterministic_memory_id !== expectedId) throw new Error("DETERMINISTIC_ID_MISMATCH")
    if (entry.provenance_status !== "legacy_unverified" || entry.memory_class !== "observation") throw new Error("LEGACY_CONTRACT_MISMATCH")
    const body = readArchiveBody(archivePath, entry.relative_path)
    if (sha256(body) !== entry.content_hash) throw new Error("CONTENT_HASH_MISMATCH")

    let retrievalTier, authorityTier, reasonCodes
    if (LOW_ALLOWLIST.has(entry.legacy_external_id)) {
      const [lockedHash, lockedReasons] = LOW_ALLOWLIST.get(entry.legacy_external_id)
      if (entry.content_hash !== lockedHash) throw new Error("LOW_ALLOWLIST_MISMATCH")
      retrievalTier = "low_authority"; authorityTier = "legacy_limited"; reasonCodes = lockedReasons
    } else if (entry.retrieval_tier === "disabled") {
      retrievalTier = "disabled"; authorityTier = "none"; reasonCodes = entry.classification_reason_codes
    } else {
      retrievalTier = "shadow_only"; authorityTier = "none"; reasonCodes = entry.classification_reason_codes
    }
    if (!Array.isArray(reasonCodes) || !reasonCodes.length) throw new Error("REASON_CODES_REQUIRED")
    return {
      ordinal, legacy_external_id: entry.legacy_external_id, content_hash: entry.content_hash,
      deterministic_memory_id: expectedId, retrieval_tier: retrievalTier, authority_tier: authorityTier,
      reason_codes: dbTextArray(reasonCodes), relative_path: entry.relative_path, body,
      original_metadata: entry.original_metadata || {}, original_lifecycle_hints: entry.original_lifecycle_hints || {},
      legacy_pin_candidate: entry.legacy_pin_candidate === true, original_archive_state: entry.archive_state || null,
      original_created_at: entry.created_hint || null, original_last_active_at: entry.last_active_hint || null,
      original_activation_count: Number.isInteger(entry.activation_count_hint) ? entry.activation_count_hint : null,
      legacy_duplicate_cluster_id: entry.duplicate_cluster_id || null, category: entry.category,
    }
  })
  const counts = Object.fromEntries(["active_legacy", "low_authority", "shadow_only", "disabled"].map((tier) => [tier, plan.filter((x) => x.retrieval_tier === tier).length]))
  if (JSON.stringify(counts) !== JSON.stringify({ active_legacy: 0, low_authority: 6, shadow_only: 95, disabled: 49 })) throw new Error("CLASSIFICATION_COUNT_MISMATCH")
  if ([...LOW_ALLOWLIST.keys()].some((id) => !seenExternal.has(id))) throw new Error("LOW_ALLOWLIST_MISSING")
  return { plan, counts, missing, unexpected, classification_digest: classificationDigest(plan), execution_order_digest: executionOrderDigest(plan) }
}

export function artifactFor(result) {
  return {
    source_sha256: SOURCE_SHA, manifest_sha256: MANIFEST_SHA,
    classification_digest: result.classification_digest, execution_order_digest: result.execution_order_digest,
    validation_result: "PASS", aggregate_counts: result.counts, missing: result.missing, unexpected: result.unexpected,
    entries: result.plan.map(({ ordinal, legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier, authority_tier, reason_codes }) =>
      ({ ordinal, legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier, authority_tier, reason_codes })),
  }
}

export function parseArgs(argv) {
  const args = { mode: "dry-run" }
  let explicitMode = null
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "--apply" || arg.startsWith("--rollback=")) {
      const nextMode = arg === "--dry-run" ? "dry-run" : arg === "--apply" ? "apply" : "rollback"
      if (explicitMode && explicitMode !== nextMode) throw new Error("CONFLICTING_MODES")
      explicitMode = nextMode; args.mode = nextMode
      if (nextMode === "rollback") args.rollback = arg.slice(11)
    }
    else if (arg.startsWith("--confirm-source-sha=")) args.confirmSourceSha = arg.slice(21)
    else if (arg.startsWith("--archive=")) args.archivePath = resolve(arg.slice(10))
    else if (arg.startsWith("--manifest=")) args.manifestPath = resolve(arg.slice(11))
    else if (arg.startsWith("--output=")) args.outputPath = resolve(arg.slice(9))
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`)
  }
  return args
}

export function assertWriteAuthorization(args) {
  if (!['apply', 'rollback'].includes(args.mode)) return
  if (args.confirmSourceSha !== SOURCE_SHA) throw new Error("CONFIRM_SOURCE_SHA_REQUIRED")
}

const planPayload = (plan) => plan.map(({ ordinal, legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier, authority_tier, reason_codes }) =>
  ({ ordinal, legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier, authority_tier, reason_codes }))

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params)
  if (error) throw new Error(`${name}:${error.code || "RPC_ERROR"}`)
  return data
}

export async function applyPlan(client, result) {
  const contractKey = result.classification_digest.slice(0, 24)
  const runId = await rpc(client, "xiaoc_memory_create_import_run", {
    p_user_id: "user", p_source_system: "ombre", p_source_snapshot_sha256: SOURCE_SHA,
    p_manifest_sha256: MANIFEST_SHA, p_execution_order_digest: result.execution_order_digest,
    p_classification_digest: result.classification_digest, p_expected_record_count: EXPECTED_COUNT,
    p_policy_version: POLICY_VERSION, p_importer_version: IMPORTER_VERSION, p_plan: planPayload(result.plan),
    p_idempotency_key: `historical-run-create:${contractKey}`,
  })
  const { data: rows, error } = await client.from("memory_import_runs").select("run_status").eq("user_id", "user").eq("id", runId).limit(1)
  if (error || !rows?.length) throw new Error("IMPORT_RUN_READ_FAILED")
  if (rows[0].run_status === "planned") await rpc(client, "xiaoc_memory_start_import_run", { p_user_id: "user", p_import_run_id: runId, p_expected_status: "planned", p_idempotency_key: `historical-run-start:${contractKey}` })
  else if (rows[0].run_status === "complete") return { runId, status: "complete" }
  else if (rows[0].run_status !== "applying") throw new Error(`IMPORT_RUN_NOT_RESUMABLE:${rows[0].run_status}`)

  for (const item of result.plan) {
    const returnedId = await rpc(client, "xiaoc_memory_import_legacy", {
      p_user_id: "user", p_import_run_id: runId, p_source_system: "ombre",
      p_legacy_external_id: item.legacy_external_id, p_original_relative_path: item.relative_path,
      p_original_content: item.body.toString("utf8"), p_original_content_hash: item.content_hash,
      p_original_metadata: item.original_metadata, p_original_lifecycle_hints: item.original_lifecycle_hints,
      p_legacy_pin_candidate: item.legacy_pin_candidate, p_original_archive_state: item.original_archive_state,
      p_original_created_at: item.original_created_at, p_original_last_active_at: item.original_last_active_at,
      p_original_activation_count: item.original_activation_count, p_legacy_policy_version: POLICY_VERSION,
      p_initial_retrieval_tier: item.retrieval_tier, p_legacy_duplicate_cluster_id: item.legacy_duplicate_cluster_id,
      p_category: item.category, p_memory_class: "observation", p_authority_policy_version: POLICY_VERSION,
      p_capture_policy_version: POLICY_VERSION,
    })
    if (returnedId !== item.deterministic_memory_id) throw new Error("RPC_DETERMINISTIC_ID_MISMATCH")
  }
  await rpc(client, "xiaoc_memory_finalize_import_run", { p_user_id: "user", p_import_run_id: runId, p_expected_status: "applying", p_idempotency_key: `historical-run-finalize:${contractKey}` })
  return { runId, status: "complete" }
}

export async function rollbackRun(client, runId, result) {
  return rpc(client, "xiaoc_memory_rollback_import_run", { p_user_id: "user", p_import_run_id: runId, p_contract_digest: result.classification_digest, p_idempotency_key: `historical-run-rollback:${runId}:${result.classification_digest.slice(0, 16)}` })
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const args = parseArgs(process.argv.slice(2))
  args.archivePath ||= "/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-08.tar.gz"
  args.manifestPath ||= resolve(root, "tmp/xiaoc-memory-engine-m2c-manifest.json")
  args.outputPath ||= resolve(root, "tmp/xiaoc-memory-engine-historical-import-dry-run.json")
  assertWriteAuthorization(args)
  const result = buildPlan(args)
  if (args.mode === "dry-run") {
    mkdirSync(dirname(args.outputPath), { recursive: true })
    writeFileSync(args.outputPath, JSON.stringify(artifactFor(result), null, 2) + "\n")
    console.log(JSON.stringify({ mode: "dry-run", canonical_records: result.plan.length, classification: result.counts, allowlist: LOW_ALLOWLIST.size, content_hashes: "150/150 PASS", deterministic_ids: "150/150 PASS", missing: result.missing.length, unexpected: result.unexpected.length, duplicates: 0, classification_digest: result.classification_digest, execution_order_digest: result.execution_order_digest, external_requests: 0, supabase_writes: 0 }))
    return
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("SUPABASE_CONFIGURATION_REQUIRED")
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const outcome = args.mode === "apply" ? await applyPlan(client, result) : { runId: args.rollback, operationId: await rollbackRun(client, args.rollback, result) }
  console.log(JSON.stringify({ mode: args.mode, ...outcome }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
