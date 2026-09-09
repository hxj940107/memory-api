import { normalizeLexicalText } from "./xiaocMemoryLexical.js"

const EXPLICIT_RECALL_PATTERNS = [
  /^(?:你)?还记得(?:我)?(?:之前|以前|上次)?(?:说过|提过|聊过)?/u,
  /^(?:我)?(?:之前|以前|上次)(?:我)?(?:是不是|有没有)?(?:说过|提过|聊过)/u,
  /^(?:关于)?上次(?:那个|那次)?/u,
]
const TRAILING_SHELL = /(?:这件事)?(?:吗|么|嘛|呢|呀|啊)[？?。！!]*$/u
const REFERENCE_PATTERN = /(?:那个|那次|这件事|后来|还.+吗|然后呢)/u
const WEAK_ONLY = /^(?:(?:那个|那次|后来|然后|真的)|还[\p{Script=Han}]{1,4})(?:呢|吗|呀|啊|？|\?)*$/u
const GENERIC_TOKENS = new Set(["我", "你", "她", "那个", "那次", "这个", "之前", "以前", "上次", "后来", "还记得", "说过", "提过", "聊过", "怎么样"])

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function extractTerms(value) {
  const normalized = normalizeLexicalText(value)
  const ascii = normalized.match(/[a-z][a-z0-9_-]*|\d+(?:\s+\d+)*/g) || []
  const cjk = normalized.match(/[\p{Script=Han}]{2,}/gu) || []
  return unique([...ascii, ...cjk].filter((term) => !GENERIC_TOKENS.has(term)))
}

function normalizeGrounding(grounding) {
  const anchors = unique((grounding?.anchors || []).map((item) => String(item?.value ?? item ?? "").trim()))
  const declared = String(grounding?.strength || "").toUpperCase()
  const strength = anchors.length && declared === "STRONG" ? "STRONG" : anchors.length ? "WEAK" : "NONE"
  return { strength, anchors }
}

export function buildXiaoCMemoryQueryPlan(rawQuery, { explicitRecall = false, mode = "normal_current", grounding = null } = {}) {
  const raw = String(rawQuery || "").trim()
  const normalized = normalizeLexicalText(raw)
  let payload = raw
  let shellMatched = false
  for (const pattern of EXPLICIT_RECALL_PATTERNS) {
    const next = payload.replace(pattern, "").trim()
    if (next !== payload) { payload = next; shellMatched = true }
  }
  payload = payload.replace(TRAILING_SHELL, "").trim()
  if (REFERENCE_PATTERN.test(raw)) payload = payload
    .replace(/^(?:之前|以前)?(?:那个|那次|这个)/u, "")
    .replace(/(?:后来)?(?:怎么样|如何)$/u, "")
    .trim()
  const grounded = normalizeGrounding(grounding)
  const implicitReference = REFERENCE_PATTERN.test(raw)
  const payloadTerms = extractTerms(payload)
  const substantivePayload = payloadTerms.join(" ")
  const selfGrounded = implicitReference && substantivePayload.length >= 2 && !WEAK_ONLY.test(raw)
  const groundingStrength = grounded.strength === "STRONG" || selfGrounded || explicitRecall ? "STRONG"
    : grounded.strength === "WEAK" || implicitReference ? "WEAK" : "NONE"
  const weakReferenceOnly = WEAK_ONLY.test(raw)
  const retrievalQuery = unique([weakReferenceOnly ? "" : (substantivePayload || payload), ...grounded.anchors]).join(" ").trim()
  const shouldRetrieve = Boolean(retrievalQuery) && !(weakReferenceOnly && grounded.strength !== "STRONG")
  const lexicalTerms = extractTerms(retrievalQuery)
  const numericTerms = normalized.match(/\d+(?:\s+\d+)*/g) || []
  const entityLikeTerms = unique(lexicalTerms.filter((term) => /[a-z0-9]/i.test(term) || [...term].length <= 8))
  return Object.freeze({
    version: "xiaoc-query-plan-v1",
    raw_query_present: Boolean(raw),
    normalized_query: normalized,
    recall_query: normalizeLexicalText(substantivePayload || payload),
    retrieval_query: retrievalQuery,
    lexical_terms: lexicalTerms,
    entity_like_terms: entityLikeTerms,
    numeric_terms: unique(numericTerms),
    reference_terms: implicitReference ? ["IMPLICIT_REFERENCE"] : [],
    explicit_recall: explicitRecall || shellMatched,
    trusted_explicit_recall: explicitRecall === true,
    implicit_reference: implicitReference,
    retrieval_mode: mode,
    grounding_strength: groundingStrength,
    grounding_anchor_count: grounded.anchors.length,
    should_retrieve: shouldRetrieve,
    reason_codes: [
      ...(shellMatched ? ["RECALL_SHELL_REMOVED"] : []),
      ...(explicitRecall ? ["EXPLICIT_RECALL_CONFIRMED"] : []),
      ...(implicitReference ? ["IMPLICIT_REFERENCE_DETECTED"] : []),
      ...(grounded.anchors.length ? [`GROUNDING_${grounded.strength}`] : []),
      shouldRetrieve ? "QUERY_PLAN_READY" : "QUERY_INSUFFICIENT_GROUNDING",
    ],
  })
}
