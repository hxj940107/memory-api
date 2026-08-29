import {
  normalizeSharedWorkingContext,
  selectPendingSharedContextMessages,
} from "./sharedContext.js"

export async function loadPendingSharedContextMessages({
  supabase,
  userId,
  conversationId,
  workingContext,
  boundAt = null,
  limit = 80,
}) {
  const normalized = normalizeSharedWorkingContext(workingContext)
  const checkpoint = normalized.conversation_checkpoints[conversationId] || null

  let recentQuery = supabase
    .from("messages")
    .select("id,role,content,created_at,metadata")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
  if (boundAt) recentQuery = recentQuery.gte("created_at", boundAt)
  const { data: recent, error: recentError } = await recentQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit)
  if (recentError) throw recentError

  const orderedRecent = [...(recent || [])].reverse()
  if (!checkpoint) return { messages: orderedRecent, reason: "no_checkpoint" }

  const inWindow = selectPendingSharedContextMessages(
    orderedRecent,
    normalized,
    conversationId,
  )
  if (orderedRecent.some(message => String(message.id) === checkpoint)) {
    return { messages: inWindow, reason: "checkpoint_in_window" }
  }

  const { data: checkpointMessage, error: checkpointError } = await supabase
    .from("messages")
    .select("id,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("id", checkpoint)
    .maybeSingle()
  if (checkpointError) throw checkpointError
  if (!checkpointMessage?.created_at) return { messages: [], reason: "checkpoint_missing" }

  const { data: afterCheckpoint, error: afterError } = await supabase
    .from("messages")
    .select("id,role,content,created_at,metadata")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .gte("created_at", checkpointMessage.created_at)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1)
  if (afterError) throw afterError

  const checkpointIndex = (afterCheckpoint || []).findIndex(
    message => String(message.id) === checkpoint,
  )
  if (checkpointIndex < 0) return { messages: [], reason: "checkpoint_missing" }
  return {
    messages: (afterCheckpoint || []).slice(checkpointIndex + 1, checkpointIndex + 1 + limit),
    reason: "checkpoint_reloaded",
  }
}
