import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { AI_ENDPOINTS, AI_MODELS, APP_USER } from "../lib/aiConfig.js"
import {
  SUMMARY_BATCH_MAX_CHARS,
  SUMMARY_BATCH_MAX_MESSAGES,
  selectSummaryBatch,
  splitOversizedSummaryMessage,
} from "../lib/summaryBatch.js"
import {
  SUMMARY_OUTPUT_MAX_TOKENS,
  buildSummaryMessages,
} from "../lib/summaryPrompt.js"
import { normalizeAssistantOutput } from "../lib/assistantOutput.js"
import {
  STRICT_SUMMARY_PROMPT_ENABLED_AT,
  getSummaryTrust,
  validateSummarySemantics,
} from "../lib/summaryPolicy.js"

export const REBUILD_CONVERSATION_ID = "chat_1783598999283"
export const REBUILT_SUMMARY_MAX_CHARS = 1500
const MESSAGE_PAGE_SIZE = 500
const REBUILD_PROVIDER_ORDER = ["Google", "Azure", "Anthropic"]

export function hashText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex")
}

export function validateRebuiltSummary(summary) {
  const chars = String(summary || "").length

  return {
    summaryChars: chars,
    maxSummaryChars: REBUILT_SUMMARY_MAX_CHARS,
    nonEmpty: chars > 0,
    withinLengthLimit: chars > 0 && chars <= REBUILT_SUMMARY_MAX_CHARS,
    applyEligible: chars > 0 && chars <= REBUILT_SUMMARY_MAX_CHARS,
  }
}

function createSummaryDiff(oldSummary, rebuiltSummary) {
  const oldLines = String(oldSummary || "").split("\n")
  const rebuiltLines = String(rebuiltSummary || "").split("\n")
  const removed = oldLines.filter(line => line && !rebuiltLines.includes(line))
  const added = rebuiltLines.filter(line => line && !oldLines.includes(line))

  return {
    removed,
    added,
    unified: [
      ...removed.map(line => `- ${line}`),
      ...added.map(line => `+ ${line}`),
    ].join("\n"),
  }
}

function parseArgs(argv) {
  const options = {
    conversationId: REBUILD_CONVERSATION_ID,
    output: resolve("tmp", `summary-rebuild-${REBUILD_CONVERSATION_ID}.json`),
    envFile: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--conversation") options.conversationId = argv[++index]
    else if (arg === "--output") options.output = resolve(argv[++index])
    else if (arg === "--env-file") options.envFile = resolve(argv[++index])
    else if (arg === "--help") options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.conversationId !== REBUILD_CONVERSATION_ID) {
    throw new Error(`This read-only script is locked to ${REBUILD_CONVERSATION_ID}`)
  }

  return options
}

function loadEnvFile(filePath) {
  if (!filePath) return
  if (!existsSync(filePath)) throw new Error(`Environment file not found: ${filePath}`)

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean || clean.startsWith("#")) continue

    const separator = clean.indexOf("=")
    if (separator < 1) continue

    const key = clean.slice(0, separator).trim()
    let value = clean.slice(separator + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!process.env[key]) process.env[key] = value
  }
}

function requireEnvironment() {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"]
  const missing = required.filter((key) => !process.env[key])

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }
}

async function loadSnapshot(supabase, conversationId) {
  const summaryResult = await supabase
    .from("conversation_summary")
    .select("summary,last_summarized_at,updated_at")
    .eq("conversation_id", conversationId)
    .maybeSingle()

  if (summaryResult.error) throw summaryResult.error
  if (!summaryResult.data) throw new Error("Conversation summary not found")

  const checkpoint = summaryResult.data.last_summarized_at
  if (!checkpoint) throw new Error("Conversation summary checkpoint missing")

  const boundaryResult = await supabase
    .from("messages")
    .select("id,created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", APP_USER.defaultUserId)
    .lte("created_at", checkpoint)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (boundaryResult.error) throw boundaryResult.error
  if (!boundaryResult.data) throw new Error("Conversation has no messages at checkpoint")

  return {
    originalSummary: summaryResult.data,
    lastMessage: boundaryResult.data,
  }
}

async function loadLegacyInventory(supabase) {
  const { data, error } = await supabase
    .from("conversation_summary")
    .select("conversation_id,last_summarized_at,updated_at")
    .lt("updated_at", STRICT_SUMMARY_PROMPT_ENABLED_AT)
    .order("updated_at", { ascending: true })

  if (error) throw error
  return data || []
}

async function loadSnapshotMessages(supabase, conversationId, snapshotLastMessage) {
  const messages = []
  let reachedSnapshot = false

  for (let offset = 0; !reachedSnapshot; offset += MESSAGE_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", conversationId)
      .eq("user_id", APP_USER.defaultUserId)
      .lte("created_at", snapshotLastMessage.created_at)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + MESSAGE_PAGE_SIZE - 1)

    if (error) throw error
    if (!data?.length) break

    const snapshotIndex = data.findIndex(
      (message) => String(message.id) === String(snapshotLastMessage.id)
    )

    if (snapshotIndex >= 0) {
      messages.push(...data.slice(0, snapshotIndex + 1))
      reachedSnapshot = true
    } else {
      messages.push(...data)
    }

    if (data.length < MESSAGE_PAGE_SIZE) break
  }

  if (!reachedSnapshot) {
    throw new Error("Snapshot boundary message was not found during pagination")
  }

  return messages
}

async function requestSummary(oldSummary, conversationData) {
  const requestMessages = buildSummaryMessages(oldSummary, conversationData)
  const inputChars = requestMessages.reduce(
    (total, message) => total + String(message.content || "").length,
    0
  )
  const startedAt = Date.now()
  const response = await fetch(AI_ENDPOINTS.openRouterChatCompletions, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODELS.summary,
      messages: requestMessages,
      max_tokens: SUMMARY_OUTPUT_MAX_TOKENS,
      provider: {
        order: REBUILD_PROVIDER_ORDER,
        allow_fallbacks: true,
      },
    }),
  })
  const data = await response.json()
  const durationMs = Date.now() - startedAt

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Summary rebuild model request failed")
    error.details = {
      status: response.status,
      code: data?.error?.code ?? null,
      provider: data?.error?.metadata?.provider_name ?? null,
      rawProvider: data?.error?.metadata?.raw ?? null,
    }
    throw error
  }

  const summary = normalizeAssistantOutput(data?.choices?.[0]?.message).trim()
  if (!summary) throw new Error("Summary rebuild model response missing")

  return {
    summary,
    metrics: {
      model: AI_MODELS.summary,
      inputMessages: requestMessages.length,
      inputChars,
      maxTokens: SUMMARY_OUTPUT_MAX_TOKENS,
      inputTokens: data?.usage?.prompt_tokens ?? null,
      outputTokens: data?.usage?.completion_tokens ?? null,
      durationMs,
      summaryChars: summary.length,
    },
  }
}

async function summarizeLogicalBatch(oldSummary, batch) {
  const inputs = batch.oversizedSingleMessage
    ? splitOversizedSummaryMessage(batch.messages[0])
    : [batch.formatted]
  const calls = []
  let summary = oldSummary

  for (const input of inputs) {
    const result = await requestSummary(summary, input)
    summary = result.summary
    calls.push(result.metrics)
  }

  return { summary, calls }
}

function sumMetric(calls, key) {
  if (calls.some((call) => call[key] == null)) return null
  return calls.reduce((total, call) => total + call[key], 0)
}

export async function rebuildSummary({ supabase, conversationId, outputPath }) {
  const startedAt = Date.now()
  const [snapshot, legacyInventory] = await Promise.all([
    loadSnapshot(supabase, conversationId),
    loadLegacyInventory(supabase),
  ])
  const rawMessages = await loadSnapshotMessages(
    supabase,
    conversationId,
    snapshot.lastMessage
  )
  const messages = rawMessages.map(message => ({
    ...message,
    content: normalizeAssistantOutput(message),
  }))
  const originalSummary = String(snapshot.originalSummary.summary || "")
  const batches = []
  let rebuiltSummary = ""
  let processedMessages = []
  let offset = 0

  while (offset < messages.length) {
    const batch = selectSummaryBatch(messages.slice(offset))
    if (!batch.messages.length) throw new Error("Summary rebuild selected an empty batch")

    const summaryCharsBefore = rebuiltSummary.length
    const priorSummary = rebuiltSummary
    const result = await summarizeLogicalBatch(rebuiltSummary, batch)
    rebuiltSummary = result.summary
    processedMessages = [...processedMessages, ...batch.messages]
    const semanticValidation = validateSummarySemantics({
      summary: rebuiltSummary,
      userMessages: processedMessages.filter(message => message.role === "user"),
      trustedPriorSummary: priorSummary,
    })

    if (!semanticValidation.valid) {
      const error = new Error("Rebuilt summary failed semantic validation")
      error.details = semanticValidation
      throw error
    }
    const first = batch.messages[0]
    const last = batch.messages[batch.messages.length - 1]

    batches.push({
      batch: batches.length + 1,
      messageCount: batch.messages.length,
      messageRange: {
        firstId: first.id,
        firstCreatedAt: first.created_at,
        lastId: last.id,
        lastCreatedAt: last.created_at,
      },
      sourceChars: batch.totalChars,
      oversizedSingleMessage: batch.oversizedSingleMessage,
      modelCallCount: result.calls.length,
      summaryCharsBefore,
      summaryCharsAfter: rebuiltSummary.length,
      inputTokens: sumMetric(result.calls, "inputTokens"),
      outputTokens: sumMetric(result.calls, "outputTokens"),
      durationMs: sumMetric(result.calls, "durationMs"),
      calls: result.calls,
      semanticValidation,
    })

    offset += batch.messages.length
  }

  const validation = validateRebuiltSummary(rebuiltSummary)
  const semanticValidation = validateSummarySemantics({
    summary: rebuiltSummary,
    userMessages: messages.filter(message => message.role === "user"),
  })
  const summaryTrust = getSummaryTrust(snapshot.originalSummary)
  const artifact = {
    artifactVersion: 2,
    mode: "read-only-rebuild",
    generatedAt: new Date().toISOString(),
    conversationId,
    source: {
      oldSummary: originalSummary,
      originalSummaryChars: originalSummary.length,
      originalSummarySha256: hashText(originalSummary),
      originalLastSummarizedAt: snapshot.originalSummary.last_summarized_at,
      originalUpdatedAt: snapshot.originalSummary.updated_at,
      trust: summaryTrust,
    },
    legacyScope: {
      strictPromptEnabledAt: STRICT_SUMMARY_PROMPT_ENABLED_AT,
      classificationBasis: "conversation_summary.updated_at before strict prompt commit time",
      deploymentTimeProven: false,
      count: legacyInventory.length,
      conversations: legacyInventory,
    },
    snapshot: {
      messageCount: messages.length,
      firstMessageId: messages[0]?.id || null,
      firstCheckpoint: messages[0]?.created_at || null,
      finalMessageId: snapshot.lastMessage.id,
      finalCheckpoint: snapshot.lastMessage.created_at,
      assistantMessagesSanitized: true,
    },
    policy: {
      maxMessagesPerBatch: SUMMARY_BATCH_MAX_MESSAGES,
      maxCharsPerBatch: SUMMARY_BATCH_MAX_CHARS,
      maxOutputTokensPerCall: SUMMARY_OUTPUT_MAX_TOKENS,
      maxRebuiltSummaryChars: REBUILT_SUMMARY_MAX_CHARS,
      providerOrder: REBUILD_PROVIDER_ORDER,
    },
    batches,
    totals: {
      batchCount: batches.length,
      modelCallCount: batches.reduce((total, batch) => total + batch.modelCallCount, 0),
      inputTokens: sumMetric(batches, "inputTokens"),
      outputTokens: sumMetric(batches, "outputTokens"),
      durationMs: Date.now() - startedAt,
    },
    result: {
      summary: rebuiltSummary,
      ...validation,
      semanticValidation,
      diff: createSummaryDiff(originalSummary, rebuiltSummary),
      applySupportedByThisScript: false,
    },
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")

  return artifact
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(`Usage: node scripts/rebuild-conversation-summary.js [options]

Options:
  --conversation ${REBUILD_CONVERSATION_ID}
  --output <artifact.json>
  --env-file <path-to-env>

This script performs SELECT queries and writes a local artifact. It never updates Supabase.`)
    return
  }

  loadEnvFile(options.envFile)
  requireEnvironment()

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
  const artifact = await rebuildSummary({
    supabase,
    conversationId: options.conversationId,
    outputPath: options.output,
  })

  console.log("SUMMARY REBUILD COMPLETE:", {
    conversationId: artifact.conversationId,
    originalSummaryChars: artifact.source.originalSummaryChars,
    originalSummarySha256: artifact.source.originalSummarySha256,
    messageCount: artifact.snapshot.messageCount,
    batchCount: artifact.totals.batchCount,
    modelCallCount: artifact.totals.modelCallCount,
    inputTokens: artifact.totals.inputTokens,
    outputTokens: artifact.totals.outputTokens,
    rebuiltSummaryChars: artifact.result.summaryChars,
    finalCheckpoint: artifact.snapshot.finalCheckpoint,
    applyEligible: artifact.result.applyEligible,
    output: options.output,
  })
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  main().catch((error) => {
    console.error("SUMMARY REBUILD FAILED:", {
      message: error?.message || String(error),
      details: error?.details || null,
    })
    process.exitCode = 1
  })
}
