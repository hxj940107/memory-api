import { createClient } from '@supabase/supabase-js'
import { requirePrivateAppRequest } from '../lib/privateAppAuth.js'
import { GENERATED_FILES_BUCKET } from '../lib/generatedFiles.js'
import { normalizeMessageVoiceAsset } from '../lib/messageVoice.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      })
    }

    const {
      user_id,
      role,
      content,
      conversation_id = "default",
      metadata = {},
      action,
      message_id
    } = req.body

    if (action === "delete") {
      if (!user_id || !message_id) {
        return res.status(400).json({
          error: "user_id and message_id are required"
        })
      }

      const { data: existingMessage } = await supabase
        .from("messages")
        .select("metadata")
        .eq("user_id", user_id)
        .eq("id", message_id)
        .maybeSingle()
      const voiceAsset = normalizeMessageVoiceAsset(existingMessage?.metadata)

      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("user_id", user_id)
        .eq("id", message_id)

      if (error) {
        return res.status(500).json({
          error: error.message
        })
      }

      if (voiceAsset) {
        const { error: voiceCleanupError } = await supabase.storage
          .from(GENERATED_FILES_BUCKET)
          .remove([voiceAsset.storage_path])
        if (voiceCleanupError) {
          console.error("MESSAGE VOICE CLEANUP FAILED:", voiceCleanupError)
        }
      }

      return res.status(200).json({
        success: true
      })
    }

    // 保存消息
    const { data, error } = await supabase
      .from("messages")
      .insert([
        {
          user_id,
          role,
          content,
          conversation_id,
          metadata
        }
      ])
      .select()

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    // 创建 conversation（仅第一次创建）
    const { data: exists } = await supabase
      .from("conversations")
      .select("conversation_id")
      .eq("conversation_id", conversation_id)
      .eq("user_id", user_id)
      .maybeSingle()

    if (!exists) {

      const title =
        (content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 20) || "新对话"

      const { error: conversationError } = await supabase
        .from("conversations")
        .insert({
          conversation_id,
          user_id,
          title
        })

      if (conversationError) {
        console.error(conversationError)
      }

    }

    return res.status(200).json({
      success: true,
      data
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}
