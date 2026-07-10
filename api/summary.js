import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const { conversation_id } = req.query;

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
