import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Only POST allowed' })
    }

    const { user_id, content, metadata } = req.body

    const { data, error } = await supabase
      .from('memories')
      .insert([
        {
          user_id,
          content,
          metadata: metadata || {}
        }
      ])
      .select()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json(data)

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
