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
      .select('created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    const groups = {}

    data.forEach(item => {
      const date = item.created_at.slice(0, 10)

      if (!groups[date]) {
        groups[date] = {
          id: date,
          title: date,
          created_at: item.created_at
        }
      }
    })

    return res.status(200).json(Object.values(groups))

  } catch (err) {
    return res.status(500).json({
      error: err.message
    })
  }
}
