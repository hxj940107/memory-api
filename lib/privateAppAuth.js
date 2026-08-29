import crypto from "crypto"

export const PRIVATE_APP_TOKEN_HEADER = "x-xiaoc-app-token"

export const isPrivateAppAuthEnabled = value => String(value || "") === "true"

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""))
  const rightBuffer = Buffer.from(String(right || ""))
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

export function authorizePrivateAppRequest(req, env = process.env) {
  if (!isPrivateAppAuthEnabled(env.XIAOC_APP_AUTH_ENABLED)) {
    return { allowed: true, mode: "compatibility" }
  }

  const configuredToken = String(env.XIAOC_APP_TOKEN || "")
  if (configuredToken.length < 32) {
    return { allowed: false, reason: "server_token_not_configured" }
  }

  const appToken = req.headers?.[PRIVATE_APP_TOKEN_HEADER]
  if (safeTokenEqual(appToken, configuredToken)) {
    return { allowed: true, mode: "private_app_token" }
  }

  const authorization = String(req.headers?.authorization || "")
  const cronSecret = String(env.CRON_SECRET || "")
  if (
    cronSecret.length >= 16
    && safeTokenEqual(authorization, `Bearer ${cronSecret}`)
  ) {
    return { allowed: true, mode: "vercel_cron" }
  }

  return { allowed: false, reason: "invalid_private_app_token" }
}

export function requirePrivateAppRequest(req, res, env = process.env) {
  const result = authorizePrivateAppRequest(req, env)
  if (result.allowed) return true

  res.status(result.reason === "server_token_not_configured" ? 503 : 401).json({
    error: result.reason,
  })
  return false
}

export function privateAppInternalHeaders(env = process.env) {
  const token = String(env.XIAOC_APP_TOKEN || "")
  return token ? { [PRIVATE_APP_TOKEN_HEADER]: token } : {}
}
