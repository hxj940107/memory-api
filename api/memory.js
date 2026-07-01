import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id || 'small_c'

    const { data, error } = await supabase
      .from('memories')
      .select('content, metadata, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(5)

    if (error) {
      return res.status(500).json({ error })
    }

    // 🧠 自动总结（轻量版，不用AI模型，节省token）
    const summary = data.map(m => m.content).join(' | ')

    return res.status(200).json({
      summary,
      memories: data
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
