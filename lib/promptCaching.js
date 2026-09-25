export const MAIN_PROMPT_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "1h",
}

export function buildCachedPromptMessages({
  persona,
  relationshipContract,
  coreMemorySnapshot,
  fixedRules,
  dynamicContext,
}) {
  const stablePrefix = {
    role: "system",
    content: [
      { type: "text", text: String(persona || "") },
      { type: "text", text: String(relationshipContract || "") },
      { type: "text", text: String(coreMemorySnapshot || "") },
      {
        type: "text",
        text: String(fixedRules || ""),
        cache_control: MAIN_PROMPT_CACHE_CONTROL,
      },
    ],
  }

  return [
    stablePrefix,
    {
      role: "system",
      content: String(dynamicContext || ""),
    },
  ]
}

export function buildPromptCacheUsageLog(usage = {}) {
  const promptDetails = usage?.prompt_tokens_details || {}
  const promptTokens = Number.isFinite(usage?.prompt_tokens)
    ? usage.prompt_tokens
    : null
  const cachedTokens = Number.isFinite(promptDetails?.cached_tokens)
    ? promptDetails.cached_tokens
    : null
  const cacheWriteTokens = Number.isFinite(promptDetails?.cache_write_tokens)
    ? promptDetails.cache_write_tokens
    : null
  const normalInputTokens = [promptTokens, cachedTokens, cacheWriteTokens]
    .every(Number.isFinite)
    ? Math.max(0, promptTokens - cachedTokens - cacheWriteTokens)
    : null

  return {
    inputTokens: promptTokens,
    normalInputTokensDerived: normalInputTokens,
    cacheReadTokens: cachedTokens,
    cacheWriteTokens,
    outputTokens: Number.isFinite(usage?.completion_tokens)
      ? usage.completion_tokens
      : null,
    totalTokens: Number.isFinite(usage?.total_tokens)
      ? usage.total_tokens
      : null,
    cost: Number.isFinite(usage?.cost) ? usage.cost : null,
    upstreamInferenceCost: Number.isFinite(usage?.cost_details?.upstream_inference_cost)
      ? usage.cost_details.upstream_inference_cost
      : null,
  }
}
