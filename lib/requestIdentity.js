import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"

export const PRIVATE_AUTH_USER_UUID = "17aa1bd0-931d-40a0-b0d6-ef75c641c7b3"
export const PRIVATE_LEGACY_USER_ID = "user"

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""))
  const b = Buffer.from(String(right || ""))
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}

function header(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : String(value || "")
}

function bearerToken(req) {
  const authorization = header(req, "authorization")
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function decodeVerifiedClaims(token) {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

function suppliedOwner(req, key) {
  const source = req?.method === "GET" ? req?.query : req?.body
  const value = source?.[key]
  return value === undefined || value === null || value === "" ? null : String(value)
}

function requestRoute(req) {
  return String(req?.url || req?.headers?.["x-vercel-route"] || "unknown").split("?")[0]
}

function expectedIssuer(supabaseUrl) {
  return `${String(supabaseUrl || "").replace(/\/$/, "")}/auth/v1`
}

function audienceIncludesAuthenticated(audience) {
  return Array.isArray(audience)
    ? audience.includes("authenticated")
    : audience === "authenticated"
}

function identityError(code, status = 401) {
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

async function loadActiveCompanion(serviceClient, authUserId) {
  const { data, error } = await serviceClient
    .from("companion_instances")
    .select("user_id,status")
    .eq("user_id", authUserId)
    .maybeSingle()
  if (error) throw identityError("companion_lookup_failed", 503)
  if (!data) throw identityError("companion_missing", 403)
  if (data.status !== "active") throw identityError("companion_inactive", 403)
  return data
}

function assertCompatibleClientOwner(req) {
  const clientUserUuid = suppliedOwner(req, "user_uuid")
  if (clientUserUuid) throw identityError("client_user_uuid_forbidden", 400)
  const clientUserId = suppliedOwner(req, "user_id")
  if (clientUserId && clientUserId !== PRIVATE_LEGACY_USER_ID) {
    throw identityError("legacy_user_id_mismatch", 403)
  }
  return clientUserId
}

function shadowLog({ route, result, reason = null, identitySource = null }) {
  console.log("TRUSTED IDENTITY SHADOW:", {
    route,
    result,
    reason,
    identity_source: identitySource,
    count: 1,
  })
}

export function observeIdentityTargetOwner(identity, targetOwnerUuid, route = "unknown") {
  if (!targetOwnerUuid || targetOwnerUuid === identity.authUserId) {
    shadowLog({ route, result: "pass", identitySource: identity.identitySource })
    return true
  }
  shadowLog({
    route,
    result: "mismatch",
    reason: "target_owner_mismatch",
    identitySource: identity.identitySource,
  })
  return false
}

export async function resolveRequestIdentity(req, {
  env = process.env,
  authClient,
  serviceClient,
  now = () => Date.now(),
} = {}) {
  const route = requestRoute(req)
  const token = bearerToken(req)
  const cronSecret = String(env.CRON_SECRET || "")

  if (token && cronSecret.length >= 16 && safeEqual(token, cronSecret)) {
    return {
      actorType: "cron",
      authUserId: null,
      legacyUserId: null,
      identitySource: "vercel_cron",
      companionStatus: null,
    }
  }

  const url = String(env.SUPABASE_URL || "")
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "")
  const jwtClient = authClient || (url && serviceKey ? createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) : null)
  const companionClient = serviceClient || jwtClient

  if (token) {
    if (!jwtClient) throw identityError("identity_verifier_not_configured", 503)
    const { data, error } = await jwtClient.auth.getUser(token)
    if (error || !data?.user) {
      throw identityError("invalid_access_token")
    }

    // Claims are inspected only after Auth has cryptographically verified the token.
    const claims = decodeVerifiedClaims(token)
    if (!claims) throw identityError("invalid_access_token")
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= now()) {
      throw identityError("access_token_expired")
    }
    if (claims.iss !== expectedIssuer(url)) throw identityError("invalid_token_issuer")
    if (!audienceIncludesAuthenticated(claims.aud)) throw identityError("invalid_token_audience")
    if (data.user.id !== claims.sub) throw identityError("verified_subject_mismatch")
    if (claims.sub !== PRIVATE_AUTH_USER_UUID) throw identityError("private_account_mismatch", 403)

    const companion = await loadActiveCompanion(companionClient, claims.sub)
    assertCompatibleClientOwner(req)
    const identity = {
      actorType: "authenticated_user",
      authUserId: claims.sub,
      legacyUserId: PRIVATE_LEGACY_USER_ID,
      identitySource: "verified_supabase_jwt",
      companionStatus: companion.status,
    }
    shadowLog({ route, result: "pass", identitySource: identity.identitySource })
    return identity
  }

  if (String(env.PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED || "") === "true") {
    const configured = String(env.XIAOC_APP_TOKEN || "")
    const supplied = header(req, "x-xiaoc-app-token")
    if (configured.length < 32 || !safeEqual(supplied, configured)) {
      throw identityError("invalid_private_app_token")
    }
    if (!companionClient) throw identityError("identity_verifier_not_configured", 503)
    const companion = await loadActiveCompanion(companionClient, PRIVATE_AUTH_USER_UUID)
    assertCompatibleClientOwner(req)
    const identity = {
      actorType: "authenticated_user",
      authUserId: PRIVATE_AUTH_USER_UUID,
      legacyUserId: PRIVATE_LEGACY_USER_ID,
      identitySource: "private_app_fixed_binding_fallback",
      companionStatus: companion.status,
    }
    shadowLog({ route, result: "pass", identitySource: identity.identitySource })
    return identity
  }

  throw identityError("authentication_required")
}

export async function requireRequestIdentity(req, res, options) {
  try {
    const identity = await resolveRequestIdentity(req, options)
    req.identity = identity
    return identity
  } catch (error) {
    shadowLog({
      route: requestRoute(req),
      result: "mismatch",
      reason: error?.code || "authentication_failed",
    })
    res.status(error?.status || 401).json({ error: error?.code || "authentication_failed" })
    return null
  }
}
