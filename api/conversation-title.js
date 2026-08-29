import { createClient } from "@supabase/supabase-js";
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return;
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
      const { error: messageError } = await supabase

        .from("messages")

        .delete()

        .eq("conversation_id", conversation_id)

        .eq("user_id", user_id);

      if (messageError) {
        return res.status(500).json({
          error: messageError.message,
        });
      }

      const { error: conversationError } = await supabase

        .from("conversations")

        .delete()

        .eq("conversation_id", conversation_id)

        .eq("user_id", user_id);

      if (conversationError) {
        return res.status(500).json({
          error: conversationError.message,
        });
      }

      return res.json({
        ok: true,
      });
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
