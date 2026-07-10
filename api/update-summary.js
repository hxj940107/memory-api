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
    // 读取最近20条聊天
    // ==========================

    const {
      data: messages,
      error: messageError
    } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(20);

    if (messageError) {
      return res.status(500).json({
        error: messageError.message
      });
    }

    // ==========================
    // 暂时直接保存聊天内容
    // 下一步再交给 Claude 总结
    // ==========================

    const summary = (messages || [])
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    const { error } = await supabase
      .from("conversation_summary")
      .upsert(
        {
          conversation_id,
          summary,
          updated_at: new Date().toISOString()
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
