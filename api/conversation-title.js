import { createClient } from "@supabase/supabase-js";
import { requireRequestIdentity } from "../lib/requestIdentity.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

export default async function handler(req, res) {
  if (!await requireRequestIdentity(req, res)) return;
  try {
    const { user_id, conversation_id, message, title, action, is_pinned } =
      req.body;

    if (!conversation_id) {
      return res.status(400).json({
        error: "no conversation_id",
      });
    }

    /*
      置顶 / 取消置顶
    */

    if (action === "pin") {
      const { error } = await supabase

        .from("conversations")

        .update({
          is_pinned,
        })

        .eq("conversation_id", conversation_id)

        .eq("user_id", user_id);

      if (error) {
        return res.status(500).json({
          error: error.message,
        });
      }

      return res.json({
        ok: true,

        is_pinned,
      });
    }

    /*
      删除聊天
    */

    if (action === "delete") {
      const { data, error } = await supabase.rpc("xiaoc_delete_conversation", {
        p_user_id: user_id,
        p_conversation_id: conversation_id,
      });
      if (error) {
        const protectedMemory = error.message?.includes("CONVERSATION_HAS_MEMORY_EVIDENCE");
        return res.status(protectedMemory ? 409 : 500).json({
          error: protectedMemory
            ? "这段聊天仍是长期记忆的来源，暂时无法直接删除。聊天和记忆均已保留。"
            : "删除失败，请稍后重试。",
          code: protectedMemory ? "CONVERSATION_HAS_MEMORY_EVIDENCE" : "CONVERSATION_DELETE_FAILED",
        });
      }
      return res.json(data);
    }

    /*
      手动修改标题
    */

    if (title) {
      const { error } = await supabase

        .from("conversations")

        .update({
          title,
        })

        .eq("conversation_id", conversation_id)

        .eq("user_id", user_id);

      if (error) {
        return res.status(500).json({
          error: error.message,
        });
      }

      return res.json({
        ok: true,

        title,
      });
    }

    /*
      第一次聊天自动生成标题
    */

    const newTitle = (message || "").slice(0, 15);

    const { error } = await supabase

      .from("conversations")

      .update({
        title: newTitle,
      })

      .eq("conversation_id", conversation_id)

      .eq("user_id", user_id);

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    return res.json({
      ok: true,

      title: newTitle,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
    });
  }
}
