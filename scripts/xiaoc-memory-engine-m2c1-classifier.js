import fs from "node:fs"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { AI_ENDPOINTS } from "../lib/aiConfig.js"

const ARCHIVE = "/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-08.tar.gz"
const MANIFEST = "tmp/xiaoc-memory-engine-m2c-manifest.json"
const OUTPUT = "tmp/xiaoc-memory-engine-m2c1-classifier-results.json"
const EXPECTED_ARCHIVE_SHA256 = "a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178"
const EXPECTED_MANIFEST_SHA256 = "861325ac1b3c8b22ce6b4aa124239c66dee08e263bceda43d5bd75930be070db"
const MODEL = "z-ai/glm-5.3"
const PROVIDER_ROUTE = "novita/fp8"
const EXPECTED_PROVIDER_NAME = "Novita"
const POLICY_VERSION = "xiaoc-m2c1-legacy-continuity-v1"
const CLASSIFIER_VERSION = `${MODEL}:temperature-0:zdr`
const MIN_CONFIDENCE = 0.9
const MAX_NETWORK_ATTEMPTS = 2
const TIMEOUT_MS = 60_000

const UNCERTAIN_IDS = new Set(`
85f4f486f3bc 3ee3eb945ef2 e9fdd6b6b293 1455a617cf68 1ddff9304494
28598fc157a1 2dd463d7f918 2f51e681fea5 32067f18f1c7 399e770228a1
3e958b0dbb9f 4b4be21d4208 652da016ffe8 7fd55777d383 81788d5bb119
82e0de7cf608 8667749f03c6 8b980fb8ef29 9cb68e34c58e 9cece63dbb04
a76890034f20 ab308e9796c8 abe3bf957e0e b00ff56048df ba2ae8640a4a
bf03a4ff4a72 c63205c695f2 d7f8678eb07a d92cd115497a ddd9891cf396
e51653c96512 29b37922a619 2fe343ae9879 3f01912f6d29 604099bf6e71
7f37a4f13676 8477e5eb02b5 98bcb724156c ba5cafb18249 c20e319cc613
c52ac25b61c3 d980ada87f42 f36bb74a64ea
`.trim().split(/\s+/))

const DETERMINISTIC_REVIEW_IDS = new Set([
  "632959ffb312", "8815e2b2c20a", "f4c1457bd8d3", "1d16fc964753", "b4db8014d06e",
])

const TEMPORAL_SCOPES = new Set(["historical", "current_or_ongoing", "future", "mixed", "uncertain"])
const DECISIONS = new Set(["low_authority", "shadow_only"])
const BLOCKING_RISKS = new Set([
  "CURRENT_STATE", "IDENTITY", "RELATIONSHIP_CURRENT_STATE", "LOCATION", "HEALTH",
  "FINANCE", "SAFETY", "PRECISE_IMPORTANT_DATE", "ONGOING_PREFERENCE", "FUTURE_PLAN",
  "UNRESOLVED_PLAN", "BEHAVIOR_RULE", "PERSONA_RULE", "RELATIONSHIP_CONTRACT",
  "CURRENT_JOB_OR_ROLE", "CURRENT_POSSESSION", "CURRENT_ROUTINE", "TEMPORAL_AMBIGUITY",
  "HIGH_AUTHORITY_CLAIM", "MIXED_CURRENT_AND_HISTORICAL", "INSUFFICIENT_CONTEXT",
])
const LOW_AUTHORITY_REASONS = new Set([
  "PAST_EVENT", "SHARED_EXPERIENCE", "COMPLETED_EVENT", "HISTORICAL_EMOTION",
  "HISTORICAL_RELATIONSHIP_MOMENT", "PAST_TRIP_OR_ACTIVITY", "PAST_CONVERSATION_MEMORY",
  "NON_CURRENT_EPISODIC_BACKGROUND",
])

const SYSTEM_PROMPT = `You are a restricted migration classifier. You do not decide whether a memory is true or current.
Your only question is whether one legacy-unverified memory is clearly a historical episode that can serve as weak conversational background.

Return exactly one JSON object with these fields:
legacy_external_id, decision, temporal_scope, risk_flags, reason_codes, policy_version, classifier_version, confidence.
policy_version must be ${POLICY_VERSION}.
classifier_version must be ${CLASSIFIER_VERSION}.

decision: low_authority or shadow_only.
temporal_scope: historical, current_or_ongoing, future, mixed, or uncertain.
risk_flags may contain only: ${[...BLOCKING_RISKS].join(", ")}.
For low_authority, reason_codes must contain at least one of: ${[...LOW_AUTHORITY_REASONS].join(", ")}.

Choose low_authority only when the content is very clearly a completed past event, shared experience, historical emotion or relationship moment, past activity/trip/conversation, or other non-current episodic background. Its value must remain meaningful specifically as a past memory even if the present has changed.

Choose shadow_only for current or ongoing facts, identity, current relationship state, location, health, finance, safety, precise important dates, ongoing preferences, future or unresolved plans, behavior/persona/relationship rules, current job/role/possession/routine, high-authority claims, mixed current and historical content, temporal ambiguity, or insufficient context.

Never invent dates, provenance, claim keys, facts, or missing context. Do not rewrite or quote the memory. If uncertain, choose shadow_only. confidence is classification confidence only, from 0 to 1.`

const SECOND_REVIEW_PROMPT = `You are the second safety reviewer for a legacy migration candidate. You may only retain a proposed low-authority historical background candidate or downgrade it to shadow-only.

Return exactly one JSON object with: legacy_external_id, decision, risk_flags, reason_codes, confidence.
decision must be retain_low_authority or downgrade_shadow_only.
risk_flags may contain only: ${[...BLOCKING_RISKS].join(", ")}.

Downgrade if the content is a current fact, preference, plan, current relationship state, mixed claim, high-authority claim, or is temporally ambiguous. Retain only when it is clearly a completed historical episode whose usefulness is limited to weak past context. Never promote, repair, rewrite, or infer missing facts.`

function sha256File(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")
}

function extractBody(relativePath) {
  const archivePath = `ombre-volume-snapshot-2026-09-08/${relativePath}`
  const raw = execFileSync("tar", ["-xOzf", ARCHIVE, archivePath], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  })
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/)
  if (!match || !match[1].trim()) throw new Error(`invalid canonical body for ${relativePath}`)
  return match[1]
}

function isNetworkError(error) {
  return error?.name === "AbortError" || error?.cause || /fetch failed|network|timeout/i.test(String(error?.message || ""))
}

async function callModel(systemPrompt, legacyExternalId, body, prior = null) {
  const request = {
    model: MODEL,
    temperature: 0,
    max_tokens: 450,
    response_format: { type: "json_object" },
    provider: {
      only: [PROVIDER_ROUTE],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          legacy_external_id: legacyExternalId,
          memory_body: body,
          ...(prior ? { first_pass: prior } : {}),
        }),
      },
    ],
  }

  let lastError
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(AI_ENDPOINTS.openRouterChatCompletions, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = new Error(`OpenRouter HTTP ${response.status}`)
        error.networkRetryable = response.status === 408 || response.status === 429 || response.status >= 500
        throw error
      }
      const payload = await response.json()
      const usedModel = payload?.model
      if (usedModel !== MODEL) throw new Error("MODEL_MISMATCH")
      if (payload?.provider !== EXPECTED_PROVIDER_NAME) throw new Error("PROVIDER_MISMATCH")
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== "string") throw new Error("MODEL_CONTENT_MISSING")
      return { parsed: JSON.parse(content), usedModel }
    } catch (error) {
      lastError = error
      const retryable = error?.networkRetryable || isNetworkError(error)
      if (!retryable || attempt === MAX_NETWORK_ATTEMPTS) throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

function validateFirstPass(raw, entry) {
  const required = [
    "legacy_external_id", "decision", "temporal_scope", "risk_flags", "reason_codes",
    "policy_version", "classifier_version", "confidence",
  ]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid: false, reason: "INVALID_JSON_OBJECT" }
  if (!required.every((key) => Object.hasOwn(raw, key))) return { valid: false, reason: "MISSING_FIELD" }
  if (raw.legacy_external_id !== entry.legacy_external_id) return { valid: false, reason: "ID_MISMATCH" }
  if (!DECISIONS.has(raw.decision) || !TEMPORAL_SCOPES.has(raw.temporal_scope)) return { valid: false, reason: "INVALID_ENUM" }
  if (!Array.isArray(raw.risk_flags) || !Array.isArray(raw.reason_codes)) return { valid: false, reason: "INVALID_ARRAY" }
  if (raw.risk_flags.some((flag) => !BLOCKING_RISKS.has(flag))) return { valid: false, reason: "INVALID_RISK_FLAG" }
  if (raw.reason_codes.some((code) => typeof code !== "string" || !code)) return { valid: false, reason: "INVALID_REASON_CODE" }
  if (raw.policy_version !== POLICY_VERSION || raw.classifier_version !== CLASSIFIER_VERSION) return { valid: false, reason: "VERSION_MISMATCH" }
  if (typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1) return { valid: false, reason: "INVALID_CONFIDENCE" }
  if (raw.decision === "low_authority" && !raw.reason_codes.some((code) => LOW_AUTHORITY_REASONS.has(code))) return { valid: false, reason: "LOW_AUTHORITY_REASON_MISSING" }
  return { valid: true }
}

function postValidate(raw, entry, schemaValidation) {
  if (!schemaValidation.valid) return { decision: "shadow_only", result: `REJECTED_${schemaValidation.reason}` }
  const eligible = raw.decision === "low_authority"
    && raw.temporal_scope === "historical"
    && raw.risk_flags.length === 0
    && raw.confidence >= MIN_CONFIDENCE
    && entry.provenance_status === "legacy_unverified"
    && entry.lifecycle_status === "active"
    && entry.retrieval_tier === "shadow_only"
    && entry.source_group !== "archive"
  return eligible
    ? { decision: "low_authority", result: "PASS" }
    : { decision: "shadow_only", result: "REJECTED_FAIL_CLOSED" }
}

function validateSecondPass(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  if (raw.legacy_external_id !== id) return false
  if (!["retain_low_authority", "downgrade_shadow_only"].includes(raw.decision)) return false
  if (!Array.isArray(raw.risk_flags) || raw.risk_flags.some((flag) => !BLOCKING_RISKS.has(flag))) return false
  if (!Array.isArray(raw.reason_codes) || raw.reason_codes.some((code) => typeof code !== "string" || !code)) return false
  return typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required")
  if (MODEL !== "z-ai/glm-5.3" || PROVIDER_ROUTE !== "novita/fp8") {
    throw new Error("classifier model/provider does not match the approved route")
  }
  if (sha256File(ARCHIVE) !== EXPECTED_ARCHIVE_SHA256) throw new Error("snapshot SHA-256 mismatch")
  if (sha256File(MANIFEST) !== EXPECTED_MANIFEST_SHA256) throw new Error("manifest SHA-256 mismatch")

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  const entries = manifest.entries.filter((entry) => UNCERTAIN_IDS.has(entry.legacy_external_id))
  if (UNCERTAIN_IDS.size !== 43 || entries.length !== 43) throw new Error("uncertain scope must contain exactly 43 records")
  if (entries.some((entry) => entry.source_group === "archive" || entry.retrieval_tier !== "shadow_only")) {
    throw new Error("scope includes a non-shadow or archive record")
  }
  if (entries.some((entry) => DETERMINISTIC_REVIEW_IDS.has(entry.legacy_external_id))) {
    throw new Error("scope overlaps deterministic review candidates")
  }

  await callModel(SYSTEM_PROMPT, "m2c1-preflight", "A completed fictional past event used only to verify JSON support.")

  const results = []
  const externallySent = new Set()
  let requestCount = 0
  for (const [index, entry] of entries.entries()) {
    const body = extractBody(entry.relative_path)
    externallySent.add(entry.legacy_external_id)
    requestCount += 1
    let raw
    let usedModel = MODEL
    let failure = null
    try {
      const response = await callModel(SYSTEM_PROMPT, entry.legacy_external_id, body)
      raw = response.parsed
      usedModel = response.usedModel
    } catch (error) {
      failure = "API_OR_PARSE_FAILURE"
      raw = {
        legacy_external_id: entry.legacy_external_id,
        decision: "shadow_only",
        temporal_scope: "uncertain",
        risk_flags: ["INSUFFICIENT_CONTEXT"],
        reason_codes: [failure],
        policy_version: POLICY_VERSION,
        classifier_version: CLASSIFIER_VERSION,
        confidence: 0,
      }
    }
    const schemaValidation = validateFirstPass(raw, entry)
    const post = postValidate(raw, entry, schemaValidation)
    results.push({
      legacy_external_id: entry.legacy_external_id,
      content_hash: entry.content_hash,
      decision: raw.decision,
      temporal_scope: raw.temporal_scope,
      risk_flags: raw.risk_flags,
      reason_codes: raw.reason_codes,
      policy_version: POLICY_VERSION,
      classifier_version: CLASSIFIER_VERSION,
      confidence: raw.confidence,
      post_validation_result: post.result,
      second_review_result: post.decision === "low_authority" ? "PENDING" : "NOT_APPLICABLE",
      final_candidate: post.decision,
      validation_failure: failure || (schemaValidation.valid ? null : schemaValidation.reason),
      external_model: usedModel,
    })
    if ((index + 1) % 5 === 0 || index + 1 === entries.length) {
      console.log(`M2C.1 classified ${index + 1}/${entries.length}`)
    }
  }

  for (const result of results.filter((item) => item.final_candidate === "low_authority")) {
    const entry = entries.find((item) => item.legacy_external_id === result.legacy_external_id)
    const body = extractBody(entry.relative_path)
    requestCount += 1
    let second
    try {
      second = (await callModel(SECOND_REVIEW_PROMPT, result.legacy_external_id, body, {
        decision: result.decision,
        temporal_scope: result.temporal_scope,
        risk_flags: result.risk_flags,
        reason_codes: result.reason_codes,
      })).parsed
    } catch {
      result.second_review_result = "REJECTED_API_OR_PARSE_FAILURE"
      result.final_candidate = "shadow_only"
      continue
    }
    if (!validateSecondPass(second, result.legacy_external_id)) {
      result.second_review_result = "REJECTED_INVALID_OUTPUT"
      result.final_candidate = "shadow_only"
    } else if (second.decision !== "retain_low_authority" || second.risk_flags.length > 0 || second.confidence < MIN_CONFIDENCE) {
      result.second_review_result = "REJECTED_SAFETY_REVIEW"
      result.final_candidate = "shadow_only"
    } else {
      result.second_review_result = "PASS"
    }
  }

  if (externallySent.size !== 43 || [...externallySent].some((id) => !UNCERTAIN_IDS.has(id))) {
    throw new Error("external scope violation")
  }
  const proposed = results.filter((item) => item.decision === "low_authority").length
  const postRejected = results.filter((item) => item.decision === "low_authority" && item.post_validation_result !== "PASS").length
  const secondRejected = results.filter((item) => item.post_validation_result === "PASS" && item.second_review_result !== "PASS").length
  const finalCandidates = results.filter((item) => item.final_candidate === "low_authority").length
  const riskCounts = {}
  for (const flag of results.flatMap((item) => item.risk_flags)) riskCounts[flag] = (riskCounts[flag] || 0) + 1
  const summary = {
    input_uncertain: 43,
    processed: results.length,
    classifier_proposed_low_authority: proposed,
    post_validator_rejected: postRejected,
    second_review_rejected: secondRejected,
    final_classifier_candidates: finalCandidates,
    existing_low_authority: 1,
    deterministic_review_candidates: 5,
    expected_final_low_authority: 1 + 5 + finalCandidates,
    non_archive_total: 101,
    non_archive_retrievable: 1 + 5 + finalCandidates,
    remaining_shadow: 100 - 5 - finalCandidates,
    archive_disabled: 49,
    risk_flag_counts: riskCounts,
    parse_failures: results.filter((item) => item.validation_failure === "API_OR_PARSE_FAILURE").length,
    validation_failures: results.filter((item) => item.validation_failure && item.validation_failure !== "API_OR_PARSE_FAILURE").length,
    external_model_used: MODEL,
    unique_records_sent_externally: externallySent.size,
    external_request_count_including_second_review: requestCount,
    other_memory_records_sent: 0,
    memory_body_persisted_in_artifact: false,
    memory_body_logged_by_script: false,
    scope_violation: false,
  }
  const artifact = {
    artifact_version: "1",
    generated_at: new Date().toISOString(),
    source_archive_sha256: EXPECTED_ARCHIVE_SHA256,
    source_manifest_sha256: EXPECTED_MANIFEST_SHA256,
    policy_version: POLICY_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    model: MODEL,
    temperature: 0,
    provider_policy: { only: [PROVIDER_ROUTE], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true },
    summary,
    results: results.map(({ external_model, validation_failure, final_candidate, ...allowed }) => allowed),
  }
  fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(summary))
}

main().catch((error) => {
  console.error(`M2C.1 failed: ${String(error?.message || error).slice(0, 180)}`)
  process.exitCode = 1
})
