import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 🧠 是否值得存储
function shouldSave(content) {
  if (!content) return false
  if (content.length < 6) return false

  const noise = ['嗯', '哦', '哈哈', 'ok', '好的', '👍']
  if (noise.includes(content.trim())) return false

  return true
}

// 🧠 自动判断重要性
function getImportance(content) {
  if (content.includes('喜欢') || content.includes('重要')) return 'high'
  if (content.length > 30) return 'medium'
  return 'low'
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Only POST allowed' })
    }

    const { user_id, content, metadata } = req.body

    if (!shouldSave(content)) {
      return res.status(200).json({ skipped: true })
    }

    const { data, error } = await supabase
      .from('memories')
      .insert([
        {
          user_id,
          content,
          metadata: {
            ...metadata,
            importance: getImportance(content)
          }
        }
      ])
      .select()

    return res.status(200).json({ data, error })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
