import { createClient } from "@supabase/supabase-js"
import {
  signGeneratedAttachmentDownload,
} from "../lib/generatedFiles.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SIGNED_URL_TTL_SECONDS = 5 * 60

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" || req.body?.action !== "sign_download") {
      return res.status(405).json({ error: "Unsupported action" })
    }

    const { user_id, conversation_id, message_id, attachment_id } = req.body
    if (!user_id || !conversation_id || !message_id || !attachment_id) {
      return res.status(400).json({ error: "Missing attachment identity" })
    }

    const result = await signGeneratedAttachmentDownload({
      supabase,
      user_id,
      conversation_id,
      message_id,
      attachment_id,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    })

    return res.status(200).json(result)
  } catch (error) {
    if (error?.code === "ATTACHMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Attachment not found" })
    }
    console.error("GENERATED FILE SIGN FAILED:", error)
    return res.status(500).json({ error: "文件暂时无法下载" })
  }
}
