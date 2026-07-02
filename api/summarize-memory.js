import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function summarize(memories) {

  const high = [];
  const recent = [];
  const tags = new Set();

  memories.forEach(m => {

    if (m.metadata?.importance === "high") {
      high.push(m.content);
    }

    if (recent.length < 5) {
      recent.push(m.content);
    }

    if (m.metadata?.type) {
      tags.add(m.metadata.type);
    }

  });

  return {
    total: memories.length,
    important: high,
    recent: recent,
    tags: [...tags],
    summary: [...new Set([...high, ...recent])].join(" | ")
  };
}

export default async function handler(req, res) {

  try {

    const user_id = req.query.user_id || "small_c";

    const { data, error } = await supabase
      .from("memories")
      .select("content, metadata, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    const result = summarize(data || []);

    return res.status(200).json(result);

  } catch (err) {

    return res.status(500).json({
      error: err.message
    });

  }

}
