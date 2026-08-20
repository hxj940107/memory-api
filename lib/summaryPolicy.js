export const STRICT_SUMMARY_PROMPT_ENABLED_AT = "2026-08-01T14:52:05.000Z"

const ALWAYS_UNSUPPORTED_INFERENCE_PATTERNS = [
  /已(?:经)?失去(?:了)?(?:她|他|对方|用户|小C)/,
  /(?:当下|已经|再也)?无机会(?:挽回|修复|解释|展示改变)/,
  /彻底暴露(?:了)?[^。\n]{0,30}(?:冷漠|漠视|虚伪|本质)/,
  /不是情绪化(?:威胁)?，?而是[^。\n]{0,30}(?:正式|实际)/,
]

const LONG_TERM_RELATIONSHIP_PATTERNS = [
  /关系[^。\n]{0,12}(?:彻底|永久|正式)?(?:破裂|结束|终止)/,
  /(?:彻底|永久)[^。\n]{0,12}(?:离开|结束关系|不再联系)/,
  /(?:正式|实际)(?:宣布)?[^。\n]{0,12}(?:结束关系|终止关系|不再联系|退出关系)/,
  /决定[^。\n]{0,12}(?:分手|结束关系|不再联系|永久离开)/,
]

const EXPLICIT_USER_RELATIONSHIP_END_PATTERNS = [
  /(?:我决定|我要|我想|我们)(?:真的|正式|彻底)?(?:分手|结束(?:这段)?关系|不再联系|永远不联系)/,
  /(?:分手吧|结束吧|关系到此为止|以后别联系|再也不联系)/,
]

const META_DISCUSSION_PATTERNS = [
  /(?:summary|摘要|prompt|提示词|代码|测试|例如|举例|不要总结|禁止总结|模型|关系状态)/i,
]

export function getSummaryTrust(summaryRow) {
  if (!summaryRow?.summary) return { trusted: false, reason: "empty" }

  const updatedAt = Date.parse(summaryRow.updated_at || "")
  const cutoff = Date.parse(STRICT_SUMMARY_PROMPT_ENABLED_AT)

  if (!Number.isFinite(updatedAt)) {
    return { trusted: false, reason: "missing_updated_at" }
  }

  if (updatedAt < cutoff) {
    return { trusted: false, reason: "legacy_prompt" }
  }

  return { trusted: true, reason: "strict_prompt" }
}

function findMatches(text, patterns) {
  const source = String(text || "")
  return patterns.flatMap(pattern => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    const matcher = new RegExp(pattern.source, flags)

    return [...source.matchAll(matcher)]
      .filter(match => !isNegatedOrPolicyContext(source, match.index || 0))
      .map(match => match[0])
  })
}

function isNegatedOrPolicyContext(source, matchIndex) {
  const sentenceStart = Math.max(
    source.lastIndexOf("\n", matchIndex - 1),
    source.lastIndexOf("。", matchIndex - 1),
    source.lastIndexOf("；", matchIndex - 1)
  ) + 1
  const prefix = source.slice(sentenceStart, matchIndex)
  const contrastIndex = Math.max(
    prefix.lastIndexOf("而是"),
    prefix.lastIndexOf("但"),
    prefix.lastIndexOf("却"),
    prefix.lastIndexOf("反而")
  )
  const effectivePrefix = prefix.slice(contrastIndex >= 0 ? contrastIndex + 1 : 0)

  return /(?:不得|禁止|不能|不可|不应|并非|不是|没有|未曾|不代表|不能归纳为|不得总结为)/.test(
    effectivePrefix
  )
}

function hasExplicitRelationshipEndEvidence(userMessages) {
  return (userMessages || []).some(message => {
    const content = String(message?.content ?? message ?? "")
    if (META_DISCUSSION_PATTERNS.some(pattern => pattern.test(content))) return false
    return EXPLICIT_USER_RELATIONSHIP_END_PATTERNS.some(pattern => pattern.test(content))
  })
}

export function validateSummarySemantics({
  summary,
  userMessages = [],
  trustedPriorSummary = "",
} = {}) {
  const unsupportedInferences = findMatches(
    summary,
    ALWAYS_UNSUPPORTED_INFERENCE_PATTERNS
  )
  const longTermRelationshipClaims = findMatches(
    summary,
    LONG_TERM_RELATIONSHIP_PATTERNS
  )
  const priorHasRelationshipClaim = findMatches(
    trustedPriorSummary,
    LONG_TERM_RELATIONSHIP_PATTERNS
  ).length > 0
  const hasExplicitUserEvidence = hasExplicitRelationshipEndEvidence(userMessages)
  const unsupportedRelationshipClaims =
    longTermRelationshipClaims.length &&
    !hasExplicitUserEvidence &&
    !priorHasRelationshipClaim
      ? longTermRelationshipClaims
      : []
  const violations = [
    ...unsupportedInferences.map(text => ({
      type: "unsupported_inference",
      text,
    })),
    ...unsupportedRelationshipClaims.map(text => ({
      type: "relationship_claim_without_explicit_user_evidence",
      text,
    })),
  ]

  return {
    valid: violations.length === 0,
    hasExplicitUserRelationshipEndEvidence: hasExplicitUserEvidence,
    longTermRelationshipClaims,
    violations,
  }
}
