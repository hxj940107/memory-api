import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  buildHistoricalActivationManifest,
  buildHistoricalActivationReviewPlan,
  computeHistoricalActivationManifestDigest,
} from "../scripts/plan-xiaoc-memory-historical-shadow-activation.js"

const row = (overrides = {}) => ({
  user_id: "user", memory_id: "10000000-0000-4000-8000-000000000001", legacy_external_id: "abc123abc123",
  content_hash: "a".repeat(64), retrieval_tier: "shadow_only", authority_tier: "none", lifecycle_status: "active",
  revision: 1, origin_system: "ombre_legacy", provenance_status: "legacy_unverified", source_group: "dynamic",
  legacy_pin_candidate: false, original_archive_state: "live", risk_codes: [], ...overrides,
})
const approvals = ["MANUAL_CONTENT_REVIEW_APPROVED", "HISTORICAL_EPISODIC_REVIEW_APPROVED", "NON_SENSITIVE_REVIEW_CONFIRMED", "NON_MUTABLE_REVIEW_CONFIRMED"]

test("review plan is body-free and excludes every deterministic unsafe class", () => {
  const safe = buildHistoricalActivationReviewPlan([row()])
  assert.equal(safe.candidates.length, 1)
  assert.equal(JSON.stringify(safe).includes("canonical_content"), false)
  for (const [override, reason] of [
    [{ original_archive_state: "archived" }, "ARCHIVED"], [{ legacy_pin_candidate: true }, "PIN"],
    [{ source_group: "permanent" }, "PERMANENT_HIGH_AUTHORITY"], [{ source_group: "feel" }, "AFFECTIVE"],
    [{ risk_codes: ["PLAN_OR_CURRENT_STATE"] }, "PLAN_OR_CURRENT_STATE"],
    [{ risk_codes: ["RELATIONSHIP_CURRENT_STATE"] }, "RELATIONSHIP_CURRENT_STATE"],
    [{ risk_codes: ["AMBIGUOUS"] }, "AMBIGUOUS"], [{ risk_codes: ["CONTRADICTORY_OR_RESOLVED"] }, "CONTRADICTORY_OR_RESOLVED"],
    [{ risk_codes: ["MANUALLY_EXCLUDED"] }, "MANUALLY_EXCLUDED"],
  ]) assert.ok(buildHistoricalActivationReviewPlan([row(override)]).excluded[0].exclusion_reason_codes.includes(reason))
})

test("manifest requires explicit approval, rejects empty/duplicate/invalid identities and has stable digest", () => {
  assert.throws(() => buildHistoricalActivationManifest([]), /EMPTY/)
  const review = { ...buildHistoricalActivationReviewPlan([row()]).candidates[0], review_status: "approved", review_reason_codes: approvals }
  const manifest = buildHistoricalActivationManifest([review])
  assert.equal(manifest.manifest_digest, computeHistoricalActivationManifestDigest(manifest.entries))
  assert.equal(manifest.entries[0].target_authority_tier, "legacy_limited")
  assert.equal(JSON.stringify(manifest).includes("native_verified"), false)
  assert.throws(() => buildHistoricalActivationManifest([{ ...review, review_reason_codes: approvals.slice(1) }]), /MANUAL/)
  assert.throws(() => buildHistoricalActivationManifest([review, review]), /DUPLICATE/)
  assert.throws(() => buildHistoricalActivationReviewPlan([row(), row()]), /DUPLICATE/)
  for (const override of [{ memory_id: "wrong" }, { legacy_external_id: "wrong" }, { content_hash: "wrong" }, { revision: 0 }]) {
    assert.throws(() => buildHistoricalActivationReviewPlan([row(override)]), /IDENTITY/)
  }
})

test("SQL locks exact state all-or-nothing, records ledger, demotes and contains grants", async () => {
  const sql = await readFile(new URL("../supabase_xiaoc_memory_engine_historical_shadow_activation.sql", import.meta.url), "utf8")
  for (const contract of ["for update", "origin_system <> 'ombre_legacy'", "provenance_status <> 'legacy_unverified'",
    "retrieval_tier <> 'shadow_only'", "authority_tier <> 'none'", "lifecycle_status <> 'active'",
    "legacy_external_id", "content_hash", "expected_revision", "original_archive_state", "legacy_pin_candidate",
    "historical_shadow_activate", "historical_shadow_demote", "compensates_operation_id", "revision=revision+1",
    "activation manifest digest mismatch", "xiaoc_memory_finish_operation"]) assert.ok(sql.includes(contract), contract)
  assert.equal(sql.includes("native_verified"), false)
  assert.equal(/grant\s+(?:insert|update|delete)/i.test(sql), false)
  const validation = await readFile(new URL("../supabase_xiaoc_memory_engine_historical_shadow_activation_validation.sql", import.meta.url), "utf8")
  assert.ok(/begin;[\s\S]*rollback;/i.test(validation))
  const rollback = await readFile(new URL("../supabase_xiaoc_memory_engine_historical_shadow_activation_rollback.sql", import.meta.url), "utf8")
  assert.equal(/delete from|drop table/i.test(rollback), false)
})
