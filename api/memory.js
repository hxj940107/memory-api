import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    // 默认用户
    const user_id = req.query.user_id || 'small_c'

    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      return res.status(500).json({
        error: error.message,
        details: error
      })
    }

    return res.status(200).json(data)

  } catch (err) {
    return res.status(500).json({
      error: err.message
    })
  }
}
