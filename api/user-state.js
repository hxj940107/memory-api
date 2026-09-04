import { createClient } from "@supabase/supabase-js"
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js"
import {
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  INACTIVITY_REACH_OUT_MODES,
  normalizeInactivityReachOutMode,
} from "../lib/aiConfig.js"
import {
  fetchMiniMaxAccountBalance,
  getShanghaiMonthStartIso,
  summarizeMiniMaxVoiceUsage,
} from "../lib/minimaxVoiceUsage.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PROFILE_IMAGE_BUCKET = "album-images"
const CLIENT_PREFERENCE_KEYS = new Set([
  "display_name",
  "selected_chat_model",
  "user_moment_avatar",
  "xiaoc_moment_avatar",
  "user_moment_bio",
  "xiaoc_moment_bio",
  "push_moments_enabled",
  "push_treehole_enabled",
  "migration_complete",
])

function normalizePreferencePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => CLIENT_PREFERENCE_KEYS.has(key))
      .map(([key, item]) => [key, item === null ? null : String(item).slice(0, 500)])
  )
}

function normalizeUsageRecord(message) {
  const usage = message?.metadata?.llmUsage
  if (!usage || typeof usage !== "object") return null
  const hasCost = usage.cost !== null && usage.cost !== undefined && usage.cost !== ""
  const cost = hasCost ? Number(usage.cost) : Number.NaN
  return {
    id: String(message.id),
    createdAt: message.created_at,
    model: String(usage.model || "unknown"),
    promptTokens: Number(usage.prompt_tokens || usage.inputTokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.outputTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
    costUsd: Number.isFinite(cost) ? cost : null,
    costSource: Number.isFinite(cost) ? "actual" : "unknown",
  }
}

async function signPreferenceImages(preferences) {
  const pathEntries = Object.entries(preferences || {})
    .filter(([key, value]) => key.endsWith("_path") && typeof value === "string" && value)
  if (!pathEntries.length) return {}
  const { data, error } = await supabase.storage
    .from(PROFILE_IMAGE_BUCKET)
    .createSignedUrls(pathEntries.map(([, path]) => path), 60 * 60 * 24 * 7)
  if (error) throw error
  const signedByPath = new Map((data || []).map(item => [item.path, item.signedUrl]))
  return Object.fromEntries(pathEntries.map(([key, path]) => [
    key.replace(/_path$/, "_uri"),
    signedByPath.get(path) || null,
  ]))
}

async function uploadPreferenceImage(userId, kind, imageBase64, imageMimeType) {
  const allowedKinds = new Set([
    "user_moment_avatar",
    "xiaoc_moment_avatar",
    "user_moment_cover",
    "xiaoc_moment_cover",
  ])
  if (!allowedKinds.has(kind)) throw new Error("invalid preference image kind")
  const rawBase64 = String(imageBase64 || "").replace(/^data:image\/[^;]+;base64,/, "")
  const buffer = Buffer.from(rawBase64, "base64")
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) throw new Error("invalid preference image")
  const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(imageMimeType)
    ? imageMimeType
    : "image/jpeg"
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"
  const path = `profiles/${userId}/${kind}-${Date.now()}.${extension}`
  const { error } = await supabase.storage
    .from(PROFILE_IMAGE_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false })
  if (error) throw error
  return path
}

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return

  try {

    const user_id =
      req.method === "GET"
        ? req.query.user_id
        : req.body.user_id

    if (!user_id) {
      return res.status(400).json({
        error: "user_id required"
      })
    }

    if (req.method === "GET" && req.query.action === "openrouter-credits") {
      try {
        const headers = {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
        }
        const [creditsRes, keyRes] = await Promise.all([
          fetch("https://openrouter.ai/api/v1/credits", { headers }),
          fetch("https://openrouter.ai/api/v1/key", { headers }).catch(() => null)
        ])

        const rawCredits = await creditsRes.json().catch(() => null)
        const rawKey = await keyRes?.json().catch(() => null)

        if (!creditsRes.ok) {
          return res.status(200).json({
            balance: null,
            total_credits: null,
            total_usage: null,
            error: rawCredits?.error?.message || "OpenRouter credits unavailable"
          })
        }

        const credits = rawCredits?.data || rawCredits || {}
        const key = keyRes?.ok ? rawKey?.data || rawKey || {} : {}
        const totalCredits = Number(
          credits.total_credits ?? credits.totalCredits ?? 0
        )
        const totalUsage = Number(
          credits.total_usage ?? credits.totalUsage ?? 0
        )
        const monthlyUsage = Number(key.usage_monthly)

        return res.status(200).json({
          balance: Math.max(totalCredits - totalUsage, 0),
          total_credits: totalCredits,
          total_usage: totalUsage,
          usage_monthly: Number.isFinite(monthlyUsage) ? monthlyUsage : null
        })
      } catch (error) {
        return res.status(200).json({
          balance: null,
          total_credits: null,
          total_usage: null,
          error: error.message
        })
      }
    }

    if (req.method === "GET" && req.query.action === "chat-usage-summary") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const recentResult = await supabase
        .from("messages")
        .select("id,created_at,metadata")
        .eq("user_id", user_id)
        .eq("role", "assistant")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(240)
      if (recentResult.error) return res.status(500).json({ error: recentResult.error.message })
      const records = (recentResult.data || []).map(normalizeUsageRecord).filter(Boolean)
      const latest = records[0] || null
      const knownCosts = records.filter(record => record.costUsd !== null)
      return res.status(200).json({
        last24hCost: knownCosts.length
          ? knownCosts.reduce((total, record) => total + record.costUsd, 0)
          : null,
        latest,
        requestCount: records.length,
      })
    }

    if (req.method === "GET" && req.query.action === "minimax-voice-usage") {
      const now = new Date()
      const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
      const monthStart = getShanghaiMonthStartIso(now)
      const queryStart = new Date(Math.min(
        new Date(dayStart).getTime(),
        new Date(monthStart).getTime(),
      )).toISOString()
      const [result, accountBalance] = await Promise.all([
        supabase
          .from("messages")
          .select("id,metadata")
          .eq("user_id", user_id)
          .eq("role", "assistant")
          .eq("metadata->voice->>provider", "minimax")
          .gte("metadata->voice->>created_at", queryStart)
          .limit(2000),
        fetchMiniMaxAccountBalance().catch(() => null),
      ])
      if (result.error) return res.status(500).json({ error: result.error.message })

      return res.status(200).json({
        currency: "CNY",
        source: "provider_usage_estimate",
        account_balance: accountBalance,
        pricing_note: "MiniMax official usage_characters × current model unit price",
        last24h: summarizeMiniMaxVoiceUsage(result.data, dayStart),
        month: summarizeMiniMaxVoiceUsage(result.data, monthStart),
      })
    }

    if (req.method === "GET" && req.query.action === "client-preferences") {
      const { data, error } = await supabase
        .from("user_state")
        .select("client_preferences")
        .eq("user_id", user_id)
        .maybeSingle()
      if (error?.code === "42703") {
        return res.status(200).json({ preferences: {}, schema_ready: false })
      }
      if (error) return res.status(500).json({ error: error.message })
      const preferences = data?.client_preferences || {}
      const signedImages = await signPreferenceImages(preferences)
      return res.status(200).json({
        preferences: { ...preferences, ...signedImages },
        has_preferences: Object.keys(preferences).length > 0,
        schema_ready: true,
      })
    }

    if (req.method === "GET" && req.query.action === "inactivity-reach-out-mode") {
      const { data, error } = await supabase
        .from("user_state")
        .select("inactivity_reach_out_mode")
        .eq("user_id", user_id)
        .maybeSingle()

      if (error && error.code !== "42703") {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({
        mode: error?.code === "42703"
          ? DEFAULT_INACTIVITY_REACH_OUT_MODE
          : normalizeInactivityReachOutMode(data?.inactivity_reach_out_mode),
      })
    }

    if (req.method === "GET" && req.query.action === "push-notification-settings") {
      const { data, error } = await supabase
        .from("user_state")
        .select("push_notifications_enabled,push_preview_enabled,push_token_updated_at,client_preferences")
        .eq("user_id", user_id)
        .maybeSingle()

      if (error?.code === "42703") {
        return res.status(200).json({ enabled: false, preview_enabled: true, schema_ready: false })
      }
      if (error) return res.status(500).json({ error: error.message })

      return res.status(200).json({
        enabled: data?.push_notifications_enabled === true,
        preview_enabled: data?.push_preview_enabled !== false,
        registered: Boolean(data?.push_token_updated_at),
        moments_enabled: data?.client_preferences?.push_moments_enabled !== "false",
        treehole_enabled: data?.client_preferences?.push_treehole_enabled !== "false",
        schema_ready: true,
      })
    }

    if (req.method === "POST") {
      if (req.body.action === "set-client-preferences") {
        const patch = normalizePreferencePatch(req.body.preferences)
        const { data: current, error: readError } = await supabase
          .from("user_state")
          .select("client_preferences")
          .eq("user_id", user_id)
          .maybeSingle()
        if (readError) return res.status(500).json({ error: readError.message })
        const next = { ...(current?.client_preferences || {}), ...patch }
        const { error } = await supabase
          .from("user_state")
          .upsert({ user_id, client_preferences: next, updated_at: new Date().toISOString() })
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ preferences: next })
      }

      if (req.body.action === "upload-client-preference-image") {
        const kind = String(req.body.kind || "")
        const path = await uploadPreferenceImage(
          user_id,
          kind,
          req.body.image_base64,
          String(req.body.image_mime_type || "image/jpeg")
        )
        const key = `${kind}_path`
        const { data: current, error: readError } = await supabase
          .from("user_state")
          .select("client_preferences")
          .eq("user_id", user_id)
          .maybeSingle()
        if (readError) return res.status(500).json({ error: readError.message })
        const next = { ...(current?.client_preferences || {}), [key]: path }
        const { error } = await supabase
          .from("user_state")
          .upsert({ user_id, client_preferences: next, updated_at: new Date().toISOString() })
        if (error) return res.status(500).json({ error: error.message })
        const signed = await signPreferenceImages(next)
        return res.status(200).json({ path, uri: signed[key.replace(/_path$/, "_uri")] || null })
      }

      if (req.body.action === "set-inactivity-reach-out-mode") {
        const mode = String(req.body.mode || "")

        if (!INACTIVITY_REACH_OUT_MODES.includes(mode)) {
          return res.status(400).json({ error: "invalid inactivity reach-out mode" })
        }

        const { data, error } = await supabase
          .from("user_state")
          .update({
            inactivity_reach_out_mode: mode,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user_id)
          .select("inactivity_reach_out_mode")
          .single()

        if (error) {
          return res.status(500).json({ error: error.message })
        }

        return res.status(200).json({
          mode: normalizeInactivityReachOutMode(data?.inactivity_reach_out_mode),
        })
      }

      if (req.body.action === "set-push-notification-settings") {
        const enabled = req.body.enabled === true
        const previewEnabled = req.body.preview_enabled !== false
        const token = String(req.body.push_token || "").trim()

        if (enabled && !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) {
          return res.status(400).json({ error: "valid Expo push token required" })
        }

        const { data: current, error: currentError } = await supabase
          .from("user_state")
          .select("client_preferences")
          .eq("user_id", user_id)
          .maybeSingle()
        if (currentError) return res.status(500).json({ error: currentError.message })
        const clientPreferences = {
          ...(current?.client_preferences || {}),
          push_moments_enabled: req.body.moments_enabled === false ? "false" : "true",
          push_treehole_enabled: req.body.treehole_enabled === false ? "false" : "true",
        }

        const { error } = await supabase
          .from("user_state")
          .update({
            push_notifications_enabled: enabled,
            push_preview_enabled: previewEnabled,
            ...(token ? { push_token: token } : {}),
            push_token_updated_at: token ? new Date().toISOString() : null,
            client_preferences: clientPreferences,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user_id)

        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({
          enabled,
          preview_enabled: previewEnabled,
          moments_enabled: clientPreferences.push_moments_enabled !== "false",
          treehole_enabled: clientPreferences.push_treehole_enabled !== "false",
        })
      }

      const { last_conversation = null } = req.body
      const payload = {
        user_id,
        last_conversation,
        updated_at: new Date().toISOString()
      }

      if (last_conversation) {
        payload.last_conversation_id = last_conversation
      }

      const { error } = await supabase
        .from("user_state")
        .upsert(payload)

      if (error) {
        return res.status(500).json({
          error: error.message
        })
      }

      return res.status(200).json({
        last_conversation
      })
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        error: "Only GET or POST allowed"
      })
    }

    const { data, error } = await supabase
      .from("user_state")
      .select("last_conversation,last_conversation_id")
      .eq("user_id", user_id)
      .single()

    if (error || !data) {
      return res.status(200).json({
        last_conversation: null
      })
    }

    return res.status(200).json({
      last_conversation: data.last_conversation_id || data.last_conversation
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}
