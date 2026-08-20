import { createClient } from "@supabase/supabase-js";
import { AI_ENDPOINTS, AI_MODELS, APP_USER } from "../lib/aiConfig.js";
import {
  SUMMARY_BATCH_MAX_MESSAGES,
  SUMMARY_BATCH_MAX_CHARS,
  SUMMARY_EXISTING_MAX_CHARS,
  processSummaryBatch,
  selectSummaryBatch,
  splitOversizedSummaryMessage,
} from "../lib/summaryBatch.js";
import {
  SUMMARY_OUTPUT_MAX_TOKENS,
  buildSummaryMessages,
} from "../lib/summaryPrompt.js";
import { normalizeAssistantOutput } from "../lib/assistantOutput.js";
import {
  getSummaryTrust,
  validateSummarySemantics,
} from "../lib/summaryPolicy.js";

const SUMMARY_QUERY_LIMIT = SUMMARY_BATCH_MAX_MESSAGES + 1

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function updateSummaryWithClaude(
  oldSummary,
  newMessages,
  batchMessageCount,
  validationMessages
) {
  const startedAt = Date.now()
  const requestMessages = buildSummaryMessages(oldSummary, newMessages)
  const inputChars = requestMessages.reduce(
    (total, item) => total + String(item.content || "").length,
    0
  )

  try {
    const response = await fetch(AI_ENDPOINTS.openRouterChatCompletions, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: AI_MODELS.summary,
        messages: requestMessages,
        max_tokens: SUMMARY_OUTPUT_MAX_TOKENS
      })
    });

    const data = await response.json();
    const summary = normalizeAssistantOutput(data?.choices?.[0]?.message).trim()

    console.log("AI TASK USAGE:", {
      task: "update-summary",
      model: AI_MODELS.summary,
      inputMessages: requestMessages.length,
      batchMessages: batchMessageCount,
      inputChars,
      maxTokens: SUMMARY_OUTPUT_MAX_TOKENS,
      success: response.ok && Boolean(summary),
      inputTokens: data?.usage?.prompt_tokens ?? null,
      outputTokens: data?.usage?.completion_tokens ?? null,
      durationMs: Date.now() - startedAt
    })

    if (!response.ok) {
      throw new Error(data?.error?.message || "Claude Summary Failed");
    }

    if (!summary) {
      throw new Error("Claude Summary Missing")
    }

    const validation = validateSummarySemantics({
      summary,
      userMessages: (validationMessages || []).filter(message => message.role === "user"),
      trustedPriorSummary: oldSummary,
    })

    if (!validation.valid) {
      console.error("SUMMARY SEMANTIC VALIDATION REJECTED:", {
        violationTypes: validation.violations.map(item => item.type),
        hasExplicitUserRelationshipEndEvidence:
          validation.hasExplicitUserRelationshipEndEvidence,
      })
      throw new Error("Summary semantic validation failed")
    }

    return summary;
  } catch (error) {
    console.error("AI TASK FAILED:", {
      task: "update-summary",
      model: AI_MODELS.summary,
      inputMessages: requestMessages.length,
      batchMessages: batchMessageCount,
      inputChars,
      maxTokens: SUMMARY_OUTPUT_MAX_TOKENS,
      success: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || "Unknown error"
    })
    throw error
  }
}

async function summarizeBatch(oldSummary, batch) {
  if (!batch.oversizedSingleMessage) {
    return updateSummaryWithClaude(
      oldSummary,
      batch.formatted,
      batch.messages.length,
      batch.messages
    )
  }

  const chunks = splitOversizedSummaryMessage(batch.messages[0])
  let summary = oldSummary

  for (const chunk of chunks) {
    summary = await updateSummaryWithClaude(summary, chunk, 1, batch.messages)
  }

  return summary
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { conversation_id, user_id = APP_USER.defaultUserId } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: "conversation_id required" });
    }

    const { data: summaryRow, error: summaryError } = await supabase
      .from("conversation_summary")
      .select("summary,last_summarized_at,updated_at")
      .eq("conversation_id", conversation_id)
      .maybeSingle();

    if (summaryError) {
      return res.status(500).json({ error: summaryError.message });
    }

    const oldSummary = summaryRow?.summary || "";
    const lastSummarizedAt = summaryRow?.last_summarized_at;
    const summaryTrust = getSummaryTrust(summaryRow)

    if (oldSummary && !summaryTrust.trusted) {
      console.warn("LEGACY SUMMARY UPDATE BLOCKED:", {
        conversationId: conversation_id,
        reason: summaryTrust.reason,
        updatedAt: summaryRow.updated_at || null,
        checkpointPreserved: true,
      })
      return res.status(409).json({
        error: "Legacy conversation summary requires a clean rebuild",
        reason: summaryTrust.reason,
        checkpointPreserved: true,
      })
    }

    if (oldSummary.length > SUMMARY_EXISTING_MAX_CHARS) {
      console.error("SUMMARY SAFETY BLOCK:", {
        conversationId: conversation_id,
        existingSummaryChars: oldSummary.length,
        maxExistingSummaryChars: SUMMARY_EXISTING_MAX_CHARS,
        checkpointPreserved: true
      })
      return res.status(409).json({
        error: "Existing conversation summary exceeds the safety limit",
        existingSummaryChars: oldSummary.length,
        checkpointPreserved: true
      })
    }

    let query = supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", conversation_id)
      .eq("user_id", user_id)
      .order("created_at", { ascending: true })
      .limit(SUMMARY_QUERY_LIMIT);

    if (lastSummarizedAt) {
      query = query.gt("created_at", lastSummarizedAt);
    }

    const { data: messages, error: messageError } = await query;

    if (messageError) {
      return res.status(500).json({ error: messageError.message });
    }

    if (!messages?.length) {
      return res.status(200).json({ success: true, message: "No new messages." });
    }

    const sanitizedMessages = messages.map(message => ({
      ...message,
      content: normalizeAssistantOutput(message),
    }))
    const batch = selectSummaryBatch(sanitizedMessages)

    if (!batch.messages.length) {
      throw new Error("Summary batch selection returned no messages")
    }

    console.log("SUMMARY BATCH:", {
      conversationId: conversation_id,
      fetchedMessages: messages.length,
      batchMessages: batch.messages.length,
      batchChars: batch.totalChars,
      maxMessages: SUMMARY_BATCH_MAX_MESSAGES,
      maxChars: SUMMARY_BATCH_MAX_CHARS,
      oversizedSingleMessage: batch.oversizedSingleMessage,
      hasMore: batch.hasMore
    })

    const { summary, checkpoint: latestTime } = await processSummaryBatch({
      oldSummary,
      batch,
      summarize: summarizeBatch,
      save: async (nextSummary, checkpoint) => {
        const result = await supabase
          .from("conversation_summary")
          .upsert(
            {
              conversation_id,
              summary: nextSummary,
              updated_at: new Date().toISOString(),
              last_summarized_at: checkpoint
            },
            { onConflict: "conversation_id" }
          );

        if (result.error) {
          throw new Error(result.error.message)
        }
      }
    })

    return res.status(200).json({
      success: true,
      summary,
      batch: {
        processedMessages: batch.messages.length,
        processedThrough: latestTime,
        hasMore: batch.hasMore
      }
    });
  } catch (err) {
    console.error("UPDATE SUMMARY ERROR:", err);

    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
