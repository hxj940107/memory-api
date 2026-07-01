import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 🧠 简单压缩（先不用LLM，后面可升级）
function summarize(memories) {
  const high = memories
    .filter(m => m.metadata?.importance === 'high')
    .map(m => m.content)

  const normal = memories
    .slice(0, 5)
    .map(m => m.content)

  return {
    high_memory: high,
    short_memory: normal,
    summary: [...high, ...normal].join(' | ')
  }
}

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id || 'small_c'

    const { data, error } = await supabase
      .from('memories')
      .select('content, metadata, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      return res.status(500).json({ error })
    }

    const result = summarize(data)

    return res.status(200).json(result)

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
