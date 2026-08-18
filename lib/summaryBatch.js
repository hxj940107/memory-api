export const SUMMARY_BATCH_MAX_MESSAGES = 50
export const SUMMARY_BATCH_MAX_CHARS = 18000
export const SUMMARY_OVERSIZED_CHUNK_CHARS = 15000
export const SUMMARY_EXISTING_MAX_CHARS = 6000

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
