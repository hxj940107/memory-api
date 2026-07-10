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

    // ===== 暂时写一个测试摘要 =====

    const summary =
      "【测试 Summary】这里以后会由 AI 自动生成。";

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
