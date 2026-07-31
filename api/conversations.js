import { createClient } from "@supabase/supabase-js";
import { APP_USER } from "../lib/aiConfig.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id || APP_USER.defaultUserId;

    const { data, error } = await supabase
      .from("conversations")
      .select("conversation_id, title, created_at, is_pinned")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    const conversations = (data || [])
      .map((item) => ({
        id: item.conversation_id,

        title: item.title || item.conversation_id,

        created_at: item.created_at,

        latest: false,

        is_pinned: item.is_pinned ?? false,
      }))
      .sort((a, b) => {
        if (a.is_pinned === b.is_pinned) {
          return 0;
        }

        return a.is_pinned ? -1 : 1;
      });

    if (conversations.length > 0) {
      conversations[0].latest = true;
    }

    return res.status(200).json(conversations);
  } catch (err) {
    return res.status(500).json({
      error: err.message,
    });
  }
}
