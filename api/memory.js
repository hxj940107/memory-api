export const config = {
  runtime: 'nodejs'
}

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
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
