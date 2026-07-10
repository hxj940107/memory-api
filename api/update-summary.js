import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      });
    }

    const { conversation_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({
        error: "conversation_id required"
      });
    }

    // ==========================
    // 读取旧 Summary
    // ==========================

    const {
      data: summaryRow,
      error: summaryError
    } = await supabase
      .from("conversation_summary")
      .select("summary, last_summarized_at")
      .eq("conversation_id", conversation_id)
      .maybeSingle();

    if (summaryError) {
      return res.status(500).json({
        error: summaryError.message
      });
    }

    const oldSummary = summaryRow?.summary || "";
    const lastSummarizedAt = summaryRow?.last_summarized_at;

    // ==========================
    // 读取新增聊天
    // ==========================

    let query = supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });

    if (lastSummarizedAt) {
      query = query.gt("created_at", lastSummarizedAt);
    }

    const {
      data: messages,
      error: messageError
    } = await query;

    if (messageError) {
      return res.status(500).json({
        error: messageError.message
      });
    }

    if (!messages || messages.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No new messages."
      });
    }

    // ==========================
    // 暂时直接拼接
    // 下一步这里改成 Claude
    // ==========================

    const newContent = messages
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    const summary = oldSummary
      ? `${oldSummary}\n${newContent}`
      : newContent;

    const latestTime =
      messages[messages.length - 1].created_at;

    const { error } = await supabase
      .from("conversation_summary")
      .upsert(
        {
          conversation_id,
          summary,
          updated_at: new Date().toISOString(),
          last_summarized_at: latestTime
        },
        {
          onConflict: "conversation_id"
        }
      );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    return res.status(200).json({
      success: true,
      summary
    });

  } catch (err) {

    return res.status(500).json({
      error: err.message
    });

  }

}
