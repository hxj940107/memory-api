export async function getLatestHistoryMessage(client, userId, conversationId) {
  const { data, error } = await client
    .from("messages")
    .select("id,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
  if (error) throw error
  return (data || []).map(({ id, created_at }) => ({ id, created_at }))
}
