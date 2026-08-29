import { createClient } from "@supabase/supabase-js";
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return;
  try {
    const conversation_id =
      req.method === "GET"
        ? req.query.conversation_id
        : req.body.conversation_id;

    if (!conversation_id) {
      return res.status(400).json({
        error: "conversation_id required"
      });
    }

    if (req.method === "DELETE") {
      const { error } = await supabase
        .from("conversation_summary")
        .update({
          summary: null,
          last_summarized_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("conversation_id", conversation_id);

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        success: true
      });
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        error: "Only GET or DELETE allowed"
      });
    }

    const { data, error } = await supabase
      .from("conversation_summary")
      .select("summary")
      .eq("conversation_id", conversation_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    return res.status(200).json({
      summary: data?.summary || ""
    });

  } catch (err) {

    return res.status(500).json({
      error: err.message
    });

  }
}
