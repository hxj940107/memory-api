export const SUMMARY_BATCH_MAX_MESSAGES = 50
export const SUMMARY_BATCH_MAX_CHARS = 18000
export const SUMMARY_OVERSIZED_CHUNK_CHARS = 15000
export const SUMMARY_EXISTING_MAX_CHARS = 6000

export function getSummaryEvidenceStats(messages = []) {
  return {
    messageCount: messages.length,
    totalChars: messages.reduce(
      (total, message) => total + formatSummaryMessage(message).length,
      0
    ),
    estimatedTokens: messages.reduce(
      (total, message) => total + estimateTextTokens(formatSummaryMessage(message)),
      0
    ),
  }
}

export function shouldRunSummaryBatch(
  messages,
  {
    minMessages = 8,
    forceChars = 4200,
    forceTokens = 900,
  } = {}
) {
  const stats = getSummaryEvidenceStats(messages)
  const shouldRun = stats.messageCount >= minMessages
    || stats.estimatedTokens >= forceTokens
    || stats.totalChars >= forceChars

  return {
    shouldRun,
    reason: stats.messageCount >= minMessages
      ? "unsummarized_message_threshold"
      : stats.estimatedTokens >= forceTokens
        ? "unsummarized_token_threshold"
        : stats.totalChars >= forceChars
          ? "unsummarized_char_threshold"
        : "summary_debounced",
    ...stats,
    minMessages,
    forceChars,
    forceTokens,
  }
}

function formatSummaryMessage(message) {
  return `${message.role}: ${String(message.content || "")}`
}

export function selectSummaryBatch(
  messages,
  {
    maxMessages = SUMMARY_BATCH_MAX_MESSAGES,
    maxChars = SUMMARY_BATCH_MAX_CHARS,
  } = {}
) {
  const batch = []
  let totalChars = 0

  for (const message of messages || []) {
    if (batch.length >= maxMessages) break

    const formatted = formatSummaryMessage(message)
    const separatorChars = batch.length ? 1 : 0

    if (batch.length && totalChars + separatorChars + formatted.length > maxChars) {
      break
    }

    batch.push(message)
    totalChars += separatorChars + formatted.length

    // A single oversized message stays intact and is summarized in ordered chunks.
    if (totalChars > maxChars) break
  }

  return {
    messages: batch,
    formatted: batch.map(formatSummaryMessage).join("\n"),
    totalChars,
    hasMore: batch.length < (messages || []).length,
    oversizedSingleMessage: batch.length === 1 && totalChars > maxChars,
  }
}

export function splitOversizedSummaryMessage(
  message,
  chunkChars = SUMMARY_OVERSIZED_CHUNK_CHARS
) {
  const content = String(message?.content || "")
  const chunks = []

  for (let offset = 0; offset < content.length; offset += chunkChars) {
    const part = content.slice(offset, offset + chunkChars)
    chunks.push(
      `${message.role}: [超长消息第 ${chunks.length + 1} 段]\n${part}`
    )
  }

  return chunks.length ? chunks : [`${message?.role || "user"}: `]
}

export async function processSummaryBatch({ oldSummary, batch, summarize, save }) {
  const summary = await summarize(oldSummary, batch)
  const checkpoint = batch.messages[batch.messages.length - 1]?.created_at

  if (!checkpoint) {
    throw new Error("Summary batch checkpoint missing")
  }

  await save(summary, checkpoint)

  return { summary, checkpoint }
}
import { estimateTextTokens } from "./dynamicContextBudget.js"
