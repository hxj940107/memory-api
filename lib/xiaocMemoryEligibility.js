const NATIVE_PROVENANCE = new Set(["verified_user", "manual_confirmed", "derived_verified"])
const LEGACY_TIERS = new Set(["active_legacy", "low_authority"])
const RETRIEVAL_MODES = new Set(["normal_current", "historical_recall"])

export const MEMORY_ELIGIBILITY_REASON = Object.freeze({
  USER_SCOPE_MISMATCH: "USER_SCOPE_MISMATCH",
  LIFECYCLE_NOT_ACTIVE: "LIFECYCLE_NOT_ACTIVE",
  RETRIEVAL_TIER_SHADOW: "RETRIEVAL_TIER_SHADOW",
  RETRIEVAL_TIER_DISABLED: "RETRIEVAL_TIER_DISABLED",
  RETRIEVAL_TIER_QUARANTINED: "RETRIEVAL_TIER_QUARANTINED",
  RETRIEVAL_TIER_INVALID: "RETRIEVAL_TIER_INVALID",
  PROVENANCE_AUTHORITY_INVALID: "PROVENANCE_AUTHORITY_INVALID",
  TEMPORAL_FUTURE: "TEMPORAL_FUTURE",
  TEMPORAL_EXPIRED: "TEMPORAL_EXPIRED",
  TEMPORAL_RESOLVED: "TEMPORAL_RESOLVED",
  SUPERSEDED_BY_RELATION: "SUPERSEDED_BY_RELATION",
  REVALIDATED_BY_RELATION: "REVALIDATED_BY_RELATION",
  SUPPRESSED_BY_HIGHER_AUTHORITY_CLAIM: "SUPPRESSED_BY_HIGHER_AUTHORITY_CLAIM",
  LEGACY_LIMITED: "LEGACY_LIMITED",
  ELIGIBLE: "ELIGIBLE",
})

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizedMode(mode) {
  const value = mode === "normal" ? "normal_current" : String(mode || "normal_current")
  if (!RETRIEVAL_MODES.has(value)) throw new Error("RETRIEVAL_MODE_INVALID")
  return value
}

export function evaluateTemporalState(memory, { retrievalTime = new Date().toISOString() } = {}) {
  const now = timestamp(retrievalTime)
  if (now === null) throw new Error("RETRIEVAL_TIME_INVALID")
  if (timestamp(memory?.resolved_at) !== null) return "resolved"
  const from = timestamp(memory?.valid_from)
  const until = timestamp(memory?.valid_until)
  if (from !== null && from > now) return "future"
  if (until !== null && until < now) return "expired"
  if (from !== null || until !== null) return "current"
  return "unknown"
}

export function evaluateCandidateEligibility(memory, context = {}) {
  const mode = normalizedMode(context.mode)
  const reasonCodes = []
  const userMatch = Boolean(context.userId) && String(memory?.user_id || "") === String(context.userId)
  if (!userMatch) reasonCodes.push(MEMORY_ELIGIBILITY_REASON.USER_SCOPE_MISMATCH)

  const lifecycle = String(memory?.lifecycle_status || "")
  const historicalLifecycle = mode === "historical_recall" && lifecycle === "archived"
  if (lifecycle !== "active" && !historicalLifecycle) reasonCodes.push(MEMORY_ELIGIBILITY_REASON.LIFECYCLE_NOT_ACTIVE)

  const provenance = String(memory?.provenance_status || "")
  const tier = memory?.retrieval_tier ?? null
  const authority = String(memory?.authority_tier || "")
  const legacy = provenance === "legacy_unverified"
  if (tier === "shadow_only") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.RETRIEVAL_TIER_SHADOW)
  else if (tier === "quarantined") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.RETRIEVAL_TIER_QUARANTINED)
  else if (tier === "disabled") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.RETRIEVAL_TIER_DISABLED)
  else if (legacy && !LEGACY_TIERS.has(tier)) reasonCodes.push(MEMORY_ELIGIBILITY_REASON.RETRIEVAL_TIER_INVALID)
  else if (!legacy && tier !== null) reasonCodes.push(MEMORY_ELIGIBILITY_REASON.RETRIEVAL_TIER_INVALID)

  if (legacy ? authority !== "legacy_limited" : (!NATIVE_PROVENANCE.has(provenance) || authority !== "native_verified")) {
    reasonCodes.push(MEMORY_ELIGIBILITY_REASON.PROVENANCE_AUTHORITY_INVALID)
  }

  const temporalState = evaluateTemporalState(memory, context)
  if (mode === "normal_current") {
    if (temporalState === "future") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.TEMPORAL_FUTURE)
    if (temporalState === "expired") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.TEMPORAL_EXPIRED)
    if (temporalState === "resolved") reasonCodes.push(MEMORY_ELIGIBILITY_REASON.TEMPORAL_RESOLVED)
  }

  const eligible = reasonCodes.length === 0
  return {
    memory_id: memory?.id ?? memory?.memory_id ?? null,
    eligible,
    authority: legacy ? "legacy_limited" : authority || "none",
    reason_codes: eligible
      ? [...(legacy ? [MEMORY_ELIGIBILITY_REASON.LEGACY_LIMITED] : []), MEMORY_ELIGIBILITY_REASON.ELIGIBLE]
      : [...new Set(reasonCodes)],
    suppressed_by: null,
    temporal_state: temporalState,
    legacy_limited: legacy && LEGACY_TIERS.has(tier) && authority === "legacy_limited",
  }
}

function authorityRank(candidate) {
  const provenance = candidate.provenance_status
  if (provenance === "verified_user" || provenance === "manual_confirmed") return 400
  if (provenance === "derived_verified") return 300
  if (provenance === "legacy_unverified") return 200
  return 0
}

function candidateTime(candidate) {
  return timestamp(candidate.valid_from) ?? timestamp(candidate.event_time) ?? timestamp(candidate.created_at) ?? 0
}

function compareClaims(left, right) {
  return authorityRank(right) - authorityRank(left)
    || candidateTime(right) - candidateTime(left)
    || String(left.id ?? left.memory_id).localeCompare(String(right.id ?? right.memory_id))
}

function relationId(relation, field) {
  return String(relation?.[field] || "")
}

function externalSuppressor(candidate, claims) {
  const id = String(candidate.id ?? candidate.memory_id ?? "")
  return (claims || []).find((claim) => {
    if (String(claim?.user_id || "") !== String(candidate.user_id || "")) return false
    const explicitIds = (claim.conflicts_with_memory_ids || []).map(String)
    if (explicitIds.includes(id)) return true
    return claim.conflict === true && claim.claim_key && String(claim.claim_key) === String(candidate.claim_key || "")
  }) || null
}

export function resolveMemoryCandidates({ candidates = [], relations = [], context = {} } = {}) {
  const decisions = new Map()
  const byId = new Map(candidates.map((candidate) => [String(candidate.id ?? candidate.memory_id), candidate]))

  for (const candidate of candidates) {
    const id = String(candidate.id ?? candidate.memory_id)
    decisions.set(id, { candidate, ...evaluateCandidateEligibility(candidate, context) })
  }

  const suppress = (id, reason, suppressor) => {
    const decision = decisions.get(String(id))
    if (!decision || !decision.eligible) return
    decision.eligible = false
    decision.reason_codes = [reason]
    decision.suppressed_by = suppressor
  }

  for (const candidate of candidates) {
    const decision = decisions.get(String(candidate.id ?? candidate.memory_id))
    if (!decision?.eligible) continue
    const claim = externalSuppressor(candidate, context.externalClaims)
    if (claim) suppress(decision.memory_id, MEMORY_ELIGIBILITY_REASON.SUPPRESSED_BY_HIGHER_AUTHORITY_CLAIM, {
      external_claim_id: claim.id ?? null,
      claim_key: claim.claim_key ?? null,
    })
  }

  const groups = new Map()
  for (const decision of decisions.values()) {
    if (!decision.eligible || !decision.candidate.claim_key) continue
    const key = String(decision.candidate.claim_key)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(decision.candidate)
  }
  for (const group of groups.values()) {
    group.sort(compareClaims)
    const winner = group[0]
    const winnerId = String(winner.id ?? winner.memory_id)
    for (const loser of group.slice(1)) {
      suppress(loser.id ?? loser.memory_id, MEMORY_ELIGIBILITY_REASON.SUPPRESSED_BY_HIGHER_AUTHORITY_CLAIM, { memory_id: winnerId, claim_key: winner.claim_key })
    }
  }

  for (const relation of relations) {
    if (String(relation?.user_id || "") !== String(context.userId || "")) continue
    const from = relationId(relation, "from_memory_id")
    const to = relationId(relation, "to_memory_id")
    // The replacing row need not match this query. A validated same-user edge is
    // sufficient to keep its old target from being resurrected by ranking.
    if (!byId.has(to) || !from) continue
    if (relation.relation_type === "supersedes") suppress(to, MEMORY_ELIGIBILITY_REASON.SUPERSEDED_BY_RELATION, { memory_id: from, relation_type: "supersedes" })
    if (relation.relation_type === "revalidates") suppress(to, MEMORY_ELIGIBILITY_REASON.REVALIDATED_BY_RELATION, { memory_id: from, relation_type: "revalidates" })
  }

  const ordered = [...decisions.values()].sort((left, right) => String(left.memory_id).localeCompare(String(right.memory_id)))
  const project = ({ candidate, ...decision }) => ({ ...candidate, eligibility: decision })
  return {
    eligible_candidates: ordered.filter((decision) => decision.eligible).map(project),
    suppressed_candidates: ordered.filter((decision) => !decision.eligible).map(project),
  }
}
