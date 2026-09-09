import assert from "node:assert/strict"
import test from "node:test"

import {
  MEMORY_ELIGIBILITY_REASON as R,
  evaluateCandidateEligibility,
  evaluateTemporalState,
  resolveMemoryCandidates,
} from "../lib/xiaocMemoryEligibility.js"
import { buildHybridCandidate, resolveOfflineCandidateEligibility } from "../lib/xiaocMemoryRetrievalFoundation.js"

const NOW = "2026-09-09T12:00:00.000Z"

function native(id, overrides = {}) {
  return {
    id,
    user_id: "xiaoc-user",
    canonical_content: `synthetic-${id}`,
    content_hash: "a".repeat(64),
    origin_system: "xiaoc_native",
    provenance_status: "verified_user",
    lifecycle_status: "active",
    retrieval_tier: null,
    authority_tier: "native_verified",
    claim_key: null,
    importance: 5,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function legacy(id, overrides = {}) {
  return native(id, {
    origin_system: "ombre_legacy",
    provenance_status: "legacy_unverified",
    retrieval_tier: "low_authority",
    authority_tier: "legacy_limited",
    ...overrides,
  })
}

function resolve(candidates, options = {}) {
  return resolveMemoryCandidates({
    candidates,
    relations: options.relations || [],
    context: { userId: "xiaoc-user", retrievalTime: NOW, mode: "normal_current", ...(options.context || {}) },
  })
}

test("same-user candidate is eligible and cross-user candidate fails closed", () => {
  assert.equal(evaluateCandidateEligibility(native("same"), { userId: "xiaoc-user", retrievalTime: NOW }).eligible, true)
  const cross = evaluateCandidateEligibility(native("cross", { user_id: "other" }), { userId: "xiaoc-user", retrievalTime: NOW })
  assert.equal(cross.eligible, false)
  assert.ok(cross.reason_codes.includes(R.USER_SCOPE_MISMATCH))
})

test("normal lifecycle gate admits only active", () => {
  assert.equal(evaluateCandidateEligibility(native("active"), { userId: "xiaoc-user", retrievalTime: NOW }).eligible, true)
  for (const lifecycle of ["superseded", "archived", "deleted"]) {
    const decision = evaluateCandidateEligibility(native(lifecycle, { lifecycle_status: lifecycle }), { userId: "xiaoc-user", retrievalTime: NOW })
    assert.equal(decision.eligible, false)
    assert.ok(decision.reason_codes.includes(R.LIFECYCLE_NOT_ACTIVE))
  }
})

test("legacy retrieval tiers enforce the real schema contract", () => {
  for (const tier of ["low_authority", "active_legacy"]) {
    const decision = evaluateCandidateEligibility(legacy(tier, { retrieval_tier: tier }), { userId: "xiaoc-user", retrievalTime: NOW })
    assert.equal(decision.eligible, true)
    assert.equal(decision.legacy_limited, true)
    assert.ok(decision.reason_codes.includes(R.LEGACY_LIMITED))
  }
  const expected = { shadow_only: R.RETRIEVAL_TIER_SHADOW, quarantined: R.RETRIEVAL_TIER_QUARANTINED, disabled: R.RETRIEVAL_TIER_DISABLED }
  for (const [tier, reason] of Object.entries(expected)) {
    const decision = evaluateCandidateEligibility(legacy(tier, { retrieval_tier: tier, authority_tier: "none" }), { userId: "xiaoc-user", retrievalTime: NOW })
    assert.equal(decision.eligible, false)
    assert.ok(decision.reason_codes.includes(reason))
  }
})

test("native provenance variants stay distinct from confidence and importance", () => {
  for (const provenance_status of ["verified_user", "manual_confirmed", "derived_verified"]) {
    assert.equal(evaluateCandidateEligibility(native(provenance_status, { provenance_status, confidence: 0, importance: 0 }), { userId: "xiaoc-user", retrievalTime: NOW }).eligible, true)
  }
  const invalid = evaluateCandidateEligibility(native("legacy-invalid", { provenance_status: "legacy_unverified", retrieval_tier: null }), { userId: "xiaoc-user", retrievalTime: NOW })
  assert.equal(invalid.eligible, false)
  assert.ok(invalid.reason_codes.includes(R.RETRIEVAL_TIER_INVALID))
})

test("temporal states are deterministic", () => {
  assert.equal(evaluateTemporalState(native("current", { valid_from: "2026-01-01", valid_until: "2026-12-01" }), { retrievalTime: NOW }), "current")
  assert.equal(evaluateTemporalState(native("future", { valid_from: "2027-01-01" }), { retrievalTime: NOW }), "future")
  assert.equal(evaluateTemporalState(native("expired", { valid_until: "2025-01-01" }), { retrievalTime: NOW }), "expired")
  assert.equal(evaluateTemporalState(native("resolved", { resolved_at: "2026-01-01" }), { retrievalTime: NOW }), "resolved")
  assert.equal(evaluateTemporalState(native("unknown"), { retrievalTime: NOW }), "unknown")
})

test("current mode suppresses non-current temporal facts while historical recall admits them", () => {
  for (const [field, value, reason] of [
    ["valid_from", "2027-01-01", R.TEMPORAL_FUTURE],
    ["valid_until", "2025-01-01", R.TEMPORAL_EXPIRED],
    ["resolved_at", "2026-01-01", R.TEMPORAL_RESOLVED],
  ]) {
    const item = native(field, { [field]: value })
    const current = evaluateCandidateEligibility(item, { userId: "xiaoc-user", retrievalTime: NOW, mode: "normal_current" })
    assert.equal(current.eligible, false)
    assert.ok(current.reason_codes.includes(reason))
    assert.equal(evaluateCandidateEligibility(item, { userId: "xiaoc-user", retrievalTime: NOW, mode: "historical_recall" }).eligible, true)
  }
})

test("verified native claim beats a newer legacy claim", () => {
  const result = resolve([
    native("verified", { claim_key: "preference:food", created_at: "2025-01-01" }),
    legacy("legacy", { claim_key: "preference:food", created_at: "2026-01-01" }),
  ])
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["verified"])
  assert.equal(result.suppressed_candidates[0].eligibility.suppressed_by.memory_id, "verified")
})

test("newer verified version wins within equal authority", () => {
  const result = resolve([
    native("older", { claim_key: "nickname", created_at: "2025-01-01" }),
    native("newer", { claim_key: "nickname", created_at: "2026-01-01" }),
  ])
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["newer"])
})

test("derived native cannot override direct verified native merely by recency", () => {
  const result = resolve([
    native("direct", { claim_key: "relationship:fact", created_at: "2025-01-01" }),
    native("derived", { claim_key: "relationship:fact", provenance_status: "derived_verified", created_at: "2026-01-01" }),
  ])
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["direct"])
})

test("missing claim keys never invent a conflict", () => {
  const result = resolve([native("a"), legacy("b")])
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["a", "b"])
})

test("supersedes relation suppresses its target before ranking", () => {
  const result = resolve([
    native("new", { lexical_score: 0.01, semantic_score: 0.01, importance: 1 }),
    legacy("old", { lexical_score: 1, semantic_score: 1, importance: 10 }),
  ], { relations: [{ user_id: "xiaoc-user", from_memory_id: "new", to_memory_id: "old", relation_type: "supersedes" }] })
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["new"])
  assert.equal(result.suppressed_candidates[0].eligibility.reason_codes[0], R.SUPERSEDED_BY_RELATION)
})

test("supersedes target stays suppressed when replacement is outside raw candidates", () => {
  const result = resolve([legacy("old", { lexical_score: 1, semantic_score: 1, importance: 10 })], {
    relations: [{ user_id: "xiaoc-user", from_memory_id: "replacement-not-ranked", to_memory_id: "old", relation_type: "supersedes" }],
  })
  assert.equal(result.eligible_candidates.length, 0)
  assert.equal(result.suppressed_candidates[0].eligibility.suppressed_by.memory_id, "replacement-not-ranked")
})

test("revalidation returns native and suppresses legacy without provenance inheritance", () => {
  const old = legacy("old")
  const result = resolve([native("new"), old], { relations: [{ user_id: "xiaoc-user", from_memory_id: "new", to_memory_id: "old", relation_type: "revalidates" }] })
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["new"])
  assert.equal(result.suppressed_candidates[0].provenance_status, "legacy_unverified")
  assert.equal(old.provenance_status, "legacy_unverified")
  assert.equal(result.suppressed_candidates[0].eligibility.reason_codes[0], R.REVALIDATED_BY_RELATION)
})

test("explicit current-user conflict suppresses lower-authority stored claim", () => {
  const result = resolve([legacy("trip", { claim_key: "plan:travel" })], {
    context: { externalClaims: [{ id: "turn-1", user_id: "xiaoc-user", claim_key: "plan:travel", conflict: true }] },
  })
  assert.equal(result.eligible_candidates.length, 0)
  assert.equal(result.suppressed_candidates[0].eligibility.suppressed_by.external_claim_id, "turn-1")
})

test("external evidence needs explicit conflict identity and cannot infer from text", () => {
  const result = resolve([legacy("trip", { claim_key: "plan:travel" })], {
    context: { externalClaims: [{ id: "turn-1", user_id: "xiaoc-user", claim_key: "plan:other" }] },
  })
  assert.deepEqual(result.eligible_candidates.map((item) => item.id), ["trip"])
})

test("candidate permutation does not change winners or reason codes", () => {
  const candidates = [
    legacy("z", { claim_key: "food", created_at: "2026-01-01" }),
    native("a", { claim_key: "food", created_at: "2025-01-01" }),
    legacy("x", { retrieval_tier: "shadow_only", authority_tier: "none" }),
  ]
  const signature = (result) => JSON.stringify(result)
  assert.equal(signature(resolve(candidates)), signature(resolve([...candidates].reverse())))
})

test("M3B1 candidate connects to M3B2 without ranking resurrection", () => {
  const safe = buildHybridCandidate({ memory: native("safe"), userId: "xiaoc-user", query: "长滩岛" })
  const unsafe = buildHybridCandidate({ memory: legacy("unsafe", { retrieval_tier: "disabled", authority_tier: "none", canonical_content: "长滩岛" }), userId: "xiaoc-user", query: "长滩岛" })
  const result = resolveOfflineCandidateEligibility({ candidates: [safe, unsafe], userId: "xiaoc-user", retrievalTime: NOW })
  assert.deepEqual(result.eligible_candidates.map((item) => item.memory_id), ["safe"])
  assert.equal(result.suppressed_candidates[0].lexical_score, 1)
})

test("resolution does not log or emit an extra Memory body field", () => {
  const original = console.log
  let calls = 0
  console.log = () => { calls += 1 }
  try {
    const result = resolve([native("private", { canonical_content: "private synthetic fixture" })])
    assert.equal(calls, 0)
    assert.equal(Object.hasOwn(result, "body"), false)
  } finally {
    console.log = original
  }
})
