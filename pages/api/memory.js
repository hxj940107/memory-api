import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  "https://cncpymfqefyabiclnqzg.supabase.co",
  "你的service_role_key"
)

export default async function handler(req, res) {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .limit(10)

  res.status(200).json({ data, error })
}
