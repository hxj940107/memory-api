import { createClient } from "@supabase/supabase-js";
import { AI_ENDPOINTS, AI_MODELS, APP_USER } from "../lib/aiConfig.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function updateSummaryWithClaude(oldSummary, newMessages) {

  const prompt = `你是 XiaoC 的“对话连续性压缩器”。

你的目标不是记录所有信息，而是让 XiaoC 在少量上下文下仍然能自然接住后续聊天。

已有连续性摘要：

${oldSummary || "（暂无）"}

--------

新增聊天：

${newMessages}

--------

请根据新增聊天更新已有连续性摘要。

要求：

- 保留对“下一轮怎么接话”仍然重要的信息
- 删除已经结束、无后续价值、只是寒暄的信息
- 不要重复
- 控制在900字以内
- 严格区分说话人：user 是用户，assistant 是小C
- 不要把 assistant/小C 说过的话总结成用户说过、用户认为或用户经历过的事
- 只有 user 明确表达过的信息，才能写入【她明确说过】
- assistant 的表达、承诺、解释、写作、修复，只能写入【小C说过或做过】
- 两人共同调试、确认、测试的内容写入【共同正在处理】
- 如果用户纠正“这是你说的/你写的，不是我说的/我写的”，必须在【禁止误归因】里保留这条纠正
- Wife Observation Diary / 观察日记默认是小C写给她、写关于她的私人观察；除非用户明确说“我写了”，否则绝不能总结成“她写的 diary”
- 技术开发内容要保留当前问题、已决定方案、未完成检查；不要保留无意义过程
- 如果正在围绕某个功能连续讨论，即使中途聊了几句别的，也必须保留这个“当前主线话题”
- 如果用户明确说“让 Codex 检查一下/修复一下”，必须保留要检查的问题、怀疑原因和当前目标
- 对正在进行的功能，不要只写成笼统“在调试”，要写清楚模块名，例如朋友圈、评论、上下文、欢迎页等
- 情绪/关系内容要保留她的感受、偏好、需要被怎样回应
- 如果新增聊天主要是在测试、确认、修 bug，只保留当前结论和待处理事项

输出格式：

【她明确说过】

【小C说过或做过】

【共同正在处理】

【待接住】

【禁止误归因】`;

  const res = await fetch(
    AI_ENDPOINTS.openRouterChatCompletions,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: AI_MODELS.summary,
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
  console.log("SUMMARY USAGE:", data?.usage || {});

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

    const {
      conversation_id,
      user_id = APP_USER.defaultUserId
    } = req.body;

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
      .eq("user_id", user_id)
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
    
    if (result.error) {
      return res.status(500).json({
        error: result.error.message
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
