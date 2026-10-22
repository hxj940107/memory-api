const CLAUDE_55 = new Set([
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-haiku-5.5",
])

// Preserve messages, tools, cache controls and output limits; adapt only model parameters.
export function buildClaudeRequest(body) {
  if (!CLAUDE_55.has(body.model)) return body
  const { temperature, top_p, top_k, reasoning_effort, include_reasoning, ...request } = body
  return {
    ...request,
    reasoning: body.model === "anthropic/claude-haiku-5.5"
      ? { enabled: false, exclude: true }
      : { effort: "low", exclude: true },
  }
}
