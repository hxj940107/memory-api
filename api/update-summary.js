import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function updateSummaryWithClaude(oldSummary, newMessages) {

  const prompt = `已有Summary：

${oldSummary || "（暂无）"}

--------

新增聊天：

${newMessages}

--------

请根据新增聊天更新已有Summary。

要求：

- 保留仍然重要的信息
- 删除已经失效的信息
- 不要重复
- 保持连续上下文
- 控制在300字以内

输出格式：

【人物】

【事件】

【关系】

【计划】

【待继续】`;

  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4.5",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  );

  const data = await res.json();
  console.log("STATUS:", res.status);
  console.log("OPENROUTER:");
  console.log(JSON.stringify(data, null, 2));
  console.log("END");

  if (!res.ok) {
    throw new Error(
      data?.error?.message || "Claude Summary Failed"
    );
  }

  return data.choices[0].message.content.trim();

}

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
      .select("summary,last_summarized_at")
      .eq("conversation_id", conversation_id)
      .maybeSingle();

    if (summaryError) {
      return res.status(500).json({
        error: summaryError.message
      });
    }

    const oldSummary = summaryRow?.summary || "";
    const lastSummarizedAt =
      summaryRow?.last_summarized_at;

    // ==========================
    // 读取新增聊天
    // ==========================

    let query = supabase
      .from("messages")
      .select("role,content,created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", {
        ascending: true
      });

    if (lastSummarizedAt) {
      query = query.gt(
        "created_at",
        lastSummarizedAt
      );
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
    // 新增聊天
    // ==========================

    const newMessages = messages
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // ==========================
    // Claude 更新 Summary
    // ==========================

    const summary =
      await updateSummaryWithClaude(
        oldSummary,
        newMessages
      );

    // ==========================
    // 保存
    // ==========================

    const latestTime =
      messages[messages.length - 1].created_at;

    const result = await supabase
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
    console.log("UPSERT RESULT:");
    console.log(result);
    
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
    console.error("UPDATE SUMMARY ERROR:");
    console.error(err);

    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });

  }

}
