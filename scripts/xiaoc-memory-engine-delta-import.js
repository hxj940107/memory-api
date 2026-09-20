#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  UUID_NAMESPACE,
  uuidV5,
  classificationDigest,
  executionOrderDigest,
} from "./xiaoc-memory-engine-historical-import.js"

const SOURCE_SHA = "a6cc6820c7396af0eb8adc2c3b1c0a8596332beb946fbaf4bf93a86038d81e5d"
const MANIFEST_SHA = "a8f06f3746b17423bce0d409b9437fd8882b75c2d213cbce0e03e5826b60a15f"
const CLASSIFICATION_DIGEST = "84db2db26c74441dcbe20d4df486b3bb30771f34c6b95a3b79b2221a96b386ba"
const EXECUTION_ORDER_DIGEST = "ff4b7d718afa1cf11e4c961860efe18e9d68718ce63b804427d6ab3687ff3e6f"
const POLICY_VERSION = "xiaoc-historical-delta-v1"
const EXPECTED_COUNT = 16
const sha256 = value => createHash("sha256").update(value).digest("hex")
const sha256File = path => sha256(readFileSync(path))

function readBody(archive, relativePath) {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) throw new Error("UNSAFE_RELATIVE_PATH")
  const raw = execFileSync("tar", ["-xOf", archive, relativePath], { maxBuffer: 8 * 1024 * 1024 })
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  if (!lines.length || lines[0].trim() !== "---") throw new Error("FRONTMATTER_MISSING")
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing < 0) throw new Error("FRONTMATTER_UNTERMINATED")
  const body = Buffer.from(lines.slice(closing + 1).join(""), "utf8")
  if (!body.toString("utf8").trim()) throw new Error("CONTENT_EMPTY")
  return body
}

export function buildDeltaPlan({ archivePath, manifestPath }) {
  if (sha256File(archivePath) !== SOURCE_SHA) throw new Error("SOURCE_SHA_MISMATCH")
  if (sha256File(manifestPath) !== MANIFEST_SHA) throw new Error("MANIFEST_SHA_MISMATCH")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.policy_version !== POLICY_VERSION || manifest.entries?.length !== EXPECTED_COUNT
    || manifest.identity?.user_id !== "user" || manifest.identity?.source_system !== "ombre") {
    throw new Error("DELTA_MANIFEST_CONTRACT_MISMATCH")
  }
  const plan = manifest.entries.map((entry, ordinal) => {
    if (!/^[0-9a-f]{12}$/.test(entry.legacy_external_id)
      || entry.source_group === "archive" || entry.lifecycle_status !== "active"
      || entry.retrieval_tier !== "shadow_only" || entry.authority_tier !== "none"
      || entry.provenance_status !== "legacy_unverified" || entry.memory_class !== "observation") {
      throw new Error("DELTA_ENTRY_CONTRACT_MISMATCH")
    }
    const deterministicMemoryId = uuidV5(UUID_NAMESPACE, ["user", "ombre", entry.legacy_external_id].join("\x1f"))
    if (deterministicMemoryId !== entry.deterministic_memory_id) throw new Error("DETERMINISTIC_ID_MISMATCH")
    const body = readBody(archivePath, entry.relative_path)
    if (sha256(body) !== entry.content_hash) throw new Error("CONTENT_HASH_MISMATCH")
    return {
      ordinal,
      legacy_external_id: entry.legacy_external_id,
      content_hash: entry.content_hash,
      deterministic_memory_id: deterministicMemoryId,
      retrieval_tier: "shadow_only",
      authority_tier: "none",
      reason_codes: entry.classification_reason_codes,
      relative_path: entry.relative_path,
      body,
      original_metadata: entry.original_metadata || {},
      original_lifecycle_hints: entry.original_lifecycle_hints || {},
      legacy_pin_candidate: entry.legacy_pin_candidate === true,
      original_archive_state: entry.archive_state || null,
      original_created_at: entry.created_hint || null,
      original_last_active_at: entry.last_active_hint || null,
      original_activation_count: Number.isInteger(entry.activation_count_hint) ? entry.activation_count_hint : null,
      legacy_duplicate_cluster_id: entry.duplicate_cluster_id || null,
      category: entry.category,
    }
  })
  if (classificationDigest(plan) !== CLASSIFICATION_DIGEST
    || executionOrderDigest(plan) !== EXECUTION_ORDER_DIGEST) throw new Error("DELTA_DIGEST_MISMATCH")
  return plan
}

const planPayload = plan => plan.map(({
  ordinal, legacy_external_id, content_hash, deterministic_memory_id,
  retrieval_tier, authority_tier, reason_codes,
}) => ({ ordinal, legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier, authority_tier, reason_codes }))

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params)
  if (error) throw new Error(`${name}:${error.code || "RPC_ERROR"}`)
  return data
}

export async function applyDelta(client, plan) {
  const key = CLASSIFICATION_DIGEST.slice(0, 24)
  const runId = await rpc(client, "xiaoc_memory_create_delta_import_run", {
    p_plan: planPayload(plan), p_idempotency_key: `historical-delta-create:${key}`,
  })
  const { data: rows, error } = await client.from("memory_import_runs")
    .select("run_status").eq("user_id", "user").eq("id", runId).limit(1)
  if (error || !rows?.length) throw new Error("DELTA_RUN_READ_FAILED")
  if (rows[0].run_status === "planned") {
    await rpc(client, "xiaoc_memory_start_import_run", {
      p_user_id: "user", p_import_run_id: runId, p_expected_status: "planned",
      p_idempotency_key: `historical-delta-start:${key}`,
    })
  } else if (rows[0].run_status === "complete") {
    return { runId, status: "complete", resumed: true }
  } else if (rows[0].run_status !== "applying") {
    throw new Error(`DELTA_RUN_NOT_RESUMABLE:${rows[0].run_status}`)
  }
  for (const item of plan) {
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
  await rpc(client, "xiaoc_memory_finalize_delta_import_run", {
    p_import_run_id: runId, p_idempotency_key: `historical-delta-finalize:${key}`,
  })
  const reconciliation = await rpc(client, "xiaoc_memory_reconcile_legacy_delta_exclusions", {
    p_source_snapshot_sha256: SOURCE_SHA,
    p_idempotency_key: `historical-delta-reconcile:${SOURCE_SHA.slice(0, 24)}`,
  })
  return { runId, status: "complete", resumed: false, reconciliation }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const apply = args.has("--apply")
  if ([...args].some(arg => arg !== "--apply" && arg !== "--dry-run")) throw new Error("UNKNOWN_ARGUMENT")
  const archivePath = resolve(process.env.XIAOC_DELTA_ARCHIVE || "/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-21.tar.gz")
  const manifestPath = resolve(process.env.XIAOC_DELTA_MANIFEST || "tmp/xiaoc-memory-delta-approved-manifest.json")
  const plan = buildDeltaPlan({ archivePath, manifestPath })
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", count: plan.length, tiers: { shadow_only: 16 }, content_hashes: "16/16 PASS", deterministic_ids: "16/16 PASS", external_requests: 0, database_writes: 0 }))
    return
  }
  if (process.env.XIAOC_CONFIRM_DELTA_SOURCE_SHA !== SOURCE_SHA) throw new Error("CONFIRM_DELTA_SOURCE_SHA_REQUIRED")
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("SUPABASE_CONFIGURATION_REQUIRED")
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const outcome = await applyDelta(client, plan)
  console.log(JSON.stringify({ mode: "apply", ...outcome, imported_count: 16, memory_bodies_logged: 0 }))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
