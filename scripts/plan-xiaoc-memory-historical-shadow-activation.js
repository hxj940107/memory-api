#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const HISTORICAL_ACTIVATION_POLICY_VERSION = "xiaoc-historical-shadow-activation-v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const LEGACY_ID = /^[0-9a-f]{12}$/
const REQUIRED_APPROVALS = new Set([
  "MANUAL_CONTENT_REVIEW_APPROVED",
  "HISTORICAL_EPISODIC_REVIEW_APPROVED",
  "NON_SENSITIVE_REVIEW_CONFIRMED",
  "NON_MUTABLE_REVIEW_CONFIRMED",
])
const FORBIDDEN_RISKS = new Set([
  "ARCHIVED", "PIN", "PERMANENT_HIGH_AUTHORITY", "AFFECTIVE", "PLAN_OR_CURRENT_STATE",
  "RELATIONSHIP_CURRENT_STATE", "MUTABLE_FACT", "AMBIGUOUS", "CONTRADICTORY_OR_RESOLVED",
  "MANUALLY_EXCLUDED",
])

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex")
const uniqueSorted = values => [...new Set((values || []).map(String).filter(Boolean))].sort()

export function computeHistoricalActivationManifestDigest(entries) {
  const canonical = [...entries]
    .sort((a, b) => String(a.memory_id).localeCompare(String(b.memory_id)))
    .map(entry => [
      entry.user_id, entry.memory_id, entry.legacy_external_id, entry.content_hash,
      String(entry.expected_revision), entry.expected_retrieval_tier,
      entry.expected_authority_tier, entry.expected_lifecycle_status,
      uniqueSorted(entry.review_reason_codes).join(","),
      entry.target_retrieval_tier, entry.target_authority_tier,
    ].map(value => String(value ?? "")).join("\u001f"))
    .join("\u001e")
  return sha256(canonical)
}

function safeIdentity(row) {
  const value = {
    user_id: String(row?.user_id || ""),
    memory_id: String(row?.memory_id || ""),
    legacy_external_id: String(row?.legacy_external_id || ""),
    content_hash: String(row?.content_hash || ""),
    expected_retrieval_tier: String(row?.retrieval_tier || ""),
    expected_authority_tier: String(row?.authority_tier || ""),
    expected_lifecycle_status: String(row?.lifecycle_status || ""),
    expected_revision: Number(row?.revision),
    origin_system: String(row?.origin_system || ""),
    provenance_status: String(row?.provenance_status || ""),
    source_group: String(row?.source_group || ""),
    legacy_pin_candidate: row?.legacy_pin_candidate === true,
    original_archive_state: row?.original_archive_state == null ? null : String(row.original_archive_state),
    risk_codes: uniqueSorted(row?.risk_codes),
  }
  if (!value.user_id || !UUID.test(value.memory_id) || !LEGACY_ID.test(value.legacy_external_id)
    || !HASH.test(value.content_hash) || !Number.isInteger(value.expected_revision) || value.expected_revision < 1) {
    throw new Error("ACTIVATION_IDENTITY_INVALID")
  }
  return value
}

function deterministicSafetyReasons(item) {
  const reasons = []
  if (item.origin_system !== "ombre_legacy") reasons.push("NOT_OMBRE_LEGACY")
  if (item.provenance_status !== "legacy_unverified") reasons.push("NOT_LEGACY_UNVERIFIED")
  if (item.expected_retrieval_tier !== "shadow_only") reasons.push("NOT_SHADOW_ONLY")
  if (item.expected_authority_tier !== "none") reasons.push("AUTHORITY_NOT_NONE")
  if (item.expected_lifecycle_status !== "active") reasons.push("NOT_ACTIVE")
  if (item.original_archive_state && item.original_archive_state !== "live") reasons.push("ARCHIVED")
  if (item.legacy_pin_candidate) reasons.push("PIN")
  if (["archive", "permanent", "feel"].includes(item.source_group)) reasons.push(
    item.source_group === "archive" ? "ARCHIVED"
      : item.source_group === "permanent" ? "PERMANENT_HIGH_AUTHORITY" : "AFFECTIVE"
  )
  reasons.push(...item.risk_codes.filter(code => FORBIDDEN_RISKS.has(code)))
  return uniqueSorted(reasons)
}

export function buildHistoricalActivationReviewPlan(rows) {
  const seen = new Set()
  const candidates = [], excluded = []
  for (const row of rows || []) {
    const item = safeIdentity(row)
    const identity = `${item.user_id}:${item.memory_id}`
    if (seen.has(identity)) throw new Error("ACTIVATION_DUPLICATE_IDENTITY")
    seen.add(identity)
    const exclusion_reason_codes = deterministicSafetyReasons(item)
    const output = {
      user_id: item.user_id, memory_id: item.memory_id,
      legacy_external_id: item.legacy_external_id, content_hash: item.content_hash,
      expected_retrieval_tier: item.expected_retrieval_tier,
      expected_authority_tier: item.expected_authority_tier,
      expected_lifecycle_status: item.expected_lifecycle_status,
      expected_revision: item.expected_revision,
      review_status: "pending_manual_content_review",
      review_reason_codes: [], target_retrieval_tier: "low_authority",
      target_authority_tier: "legacy_limited",
    }
    if (exclusion_reason_codes.length) excluded.push({ ...output, exclusion_reason_codes })
    else candidates.push(output)
  }
  return { policy_version: HISTORICAL_ACTIVATION_POLICY_VERSION, candidates, excluded }
}

export function buildHistoricalActivationManifest(reviewedRows) {
  if (!Array.isArray(reviewedRows) || reviewedRows.length === 0) throw new Error("ACTIVATION_MANIFEST_EMPTY")
  const seen = new Set()
  const entries = reviewedRows.map(row => {
    const identity = safeIdentity({
      ...row,
      retrieval_tier: row.expected_retrieval_tier,
      authority_tier: row.expected_authority_tier,
      lifecycle_status: row.expected_lifecycle_status,
      revision: row.expected_revision,
      origin_system: "ombre_legacy",
      provenance_status: "legacy_unverified",
    })
    const approvals = uniqueSorted(row.review_reason_codes)
    const identityKey = `${identity.user_id}:${identity.memory_id}`
    if (seen.has(identityKey)) throw new Error("ACTIVATION_DUPLICATE_IDENTITY")
    seen.add(identityKey)
    if (row.review_status !== "approved" || [...REQUIRED_APPROVALS].some(code => !approvals.includes(code))
      || approvals.some(code => FORBIDDEN_RISKS.has(code))) throw new Error("MANUAL_CONTENT_REVIEW_REQUIRED")
    return {
      user_id: identity.user_id, memory_id: identity.memory_id,
      legacy_external_id: identity.legacy_external_id, content_hash: identity.content_hash,
      expected_revision: identity.expected_revision,
      expected_retrieval_tier: identity.expected_retrieval_tier,
      expected_authority_tier: identity.expected_authority_tier,
      expected_lifecycle_status: identity.expected_lifecycle_status,
      review_reason_codes: approvals,
      target_retrieval_tier: "low_authority", target_authority_tier: "legacy_limited",
    }
  }).sort((a, b) => a.memory_id.localeCompare(b.memory_id))
  return {
    policy_version: HISTORICAL_ACTIVATION_POLICY_VERSION,
    manifest_digest: computeHistoricalActivationManifestDigest(entries),
    expected_count: entries.length,
    entries,
  }
}

function parseArgs(argv) {
  const args = Object.fromEntries(argv.slice(2).map(value => value.split("=", 2)))
  if (!args["--input"] || !args["--output"]) throw new Error("USAGE: --input=PATH --output=PATH [--mode=review|manifest]")
  return { input: resolve(args["--input"]), output: resolve(args["--output"]), mode: args["--mode"] || "review" }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = parseArgs(process.argv)
  const rows = JSON.parse(readFileSync(args.input, "utf8"))
  const result = args.mode === "manifest"
    ? buildHistoricalActivationManifest(rows)
    : buildHistoricalActivationReviewPlan(rows)
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ mode: args.mode, candidates: result.candidates?.length, excluded: result.excluded?.length, expected_count: result.expected_count }))
}
