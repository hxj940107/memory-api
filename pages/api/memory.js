import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  const { user_id = "small_c" } = req.query

  const { data } = await supabase
    .from('memories')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(20)

  res.status(200).json(data)
}
