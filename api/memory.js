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
    const result = await supabase
      .from('memories')
      .select('*')
      .limit(10)

    // 🔴 关键：把完整结果打出来
    return res.status(200).json({
      data: result.data,
      error: result.error,
      status: result.status
    })

  } catch (err) {
    return res.status(500).json({
      crash: err.message,
      stack: err.stack
    })
  }
}
