import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  PRIVATE_AUTH_USER_UUID,
  requireRequestIdentity,
  resolveRequestIdentity,
} from "../lib/requestIdentity.js"

const url = "https://project-ref.supabase.co"
const env = {
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
}

function tokenFor(overrides = {}) {
  const claims = {
    sub: PRIVATE_AUTH_USER_UUID,
    iss: `${url}/auth/v1`,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

function request(token, body = { user_id: "user" }) {
  return {
    method: "POST",
    url: "/api/chat",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  }
}

function clients({
  authUserId = PRIVATE_AUTH_USER_UUID,
  authError = null,
  companion = "active",
  companionError = null,
} = {}) {
  return {
    authClient: {
      auth: {
        async getUser() {
          return authError
            ? { data: { user: null }, error: typeof authError === "string" ? new Error(authError) : authError }
            : { data: { user: { id: authUserId } }, error: null }
        },
      },
    },
    serviceClient: {
      from() {
        return {
          select() { return this },
          eq() { return this },
          async maybeSingle() {
            if (companionError) return { data: null, error: new Error(companionError) }
            return companion === "missing"
              ? { data: null, error: null }
              : {
                  data: {
                    user_id: PRIVATE_AUTH_USER_UUID,
                    lifecycle_status: companion,
                  },
                  error: null,
                }
          },
        }
      },
    },
  }
}

test("valid verified JWT resolves the fixed private companion identity", async () => {
  const identity = await resolveRequestIdentity(request(tokenFor()), { env, ...clients() })
  assert.deepEqual(identity, {
    actorType: "authenticated_user",
    authUserId: PRIVATE_AUTH_USER_UUID,
    legacyUserId: "user",
    identitySource: "verified_supabase_jwt",
    companionStatus: "active",
  })
})

test("cron bearer takes precedence and does not require a companion lookup", async () => {
  const cronEnv = {
    ...env,
    CRON_SECRET: "cron-secret-value-long-enough",
  }
  const identity = await resolveRequestIdentity(
    request(cronEnv.CRON_SECRET),
    {
      env: cronEnv,
      authClient: {
        auth: {
          async getUser() {
            assert.fail("cron bearer must not be treated as a Supabase JWT")
          },
        },
      },
      serviceClient: {
        from() {
          assert.fail("cron identity must not require a companion lookup")
        },
      },
    },
  )
  assert.deepEqual(identity, {
    actorType: "cron",
    authUserId: null,
    legacyUserId: null,
    identitySource: "vercel_cron",
    companionStatus: null,
  })
})

test("expired JWT fails closed", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor({ exp: 1 })), { env, ...clients(), now: () => 2000 }),
    { code: "access_token_expired" },
  )
})

test("issuer and audience must match the configured Supabase project", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor({ iss: "https://other.supabase.co/auth/v1" })), {
      env,
      ...clients(),
    }),
    { code: "invalid_token_issuer" },
  )
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor({ aud: "anon" })), { env, ...clients() }),
    { code: "invalid_token_audience" },
  )
})

test("invalid signature result from Supabase Auth fails closed", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor()), { env, ...clients({ authError: "bad signature" }) }),
    { code: "invalid_access_token", status: 401, retryable: false },
  )
})

test("provider network, timeout, rate-limit and 5xx failures are transient", async () => {
  const failures = [
    Object.assign(new Error("fetch failed"), { name: "AuthRetryableFetchError" }),
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("service unavailable"), { status: 503 }),
  ]
  const expectedClasses = ["network", "timeout", "rate_limited", "provider_5xx"]
  for (let index = 0; index < failures.length; index += 1) {
    await assert.rejects(
      resolveRequestIdentity(request(tokenFor()), { env, ...clients({ authError: failures[index] }) }),
      {
        code: "auth_provider_unavailable",
        status: 503,
        retryable: true,
        providerFailureClass: expectedClasses[index],
      },
    )
  }
})

test("unknown verification errors remain invalid and fail closed", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor()), {
      env,
      ...clients({ authError: Object.assign(new Error("unknown"), { status: 418 }) }),
    }),
    { code: "invalid_access_token", status: 401, retryable: false },
  )
})

test("Bearer provider failure never falls back to a valid app token", async () => {
  const fallbackEnv = {
    ...env,
    PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true",
    XIAOC_APP_TOKEN: "a".repeat(48),
  }
  const req = request(tokenFor())
  req.headers["x-xiaoc-app-token"] = fallbackEnv.XIAOC_APP_TOKEN
  await assert.rejects(
    resolveRequestIdentity(req, {
      env: fallbackEnv,
      ...clients({ authError: Object.assign(new Error("unavailable"), { status: 503 }) }),
    }),
    { code: "auth_provider_unavailable", status: 503, retryable: true },
  )
})

test("HTTP auth failures expose only privacy-safe classification metadata", async () => {
  let responseStatus = null
  let responseBody = null
  const res = {
    status(value) { responseStatus = value; return this },
    json(value) { responseBody = value },
  }
  const identity = await requireRequestIdentity(request(tokenFor()), res, {
    env,
    ...clients({ authError: Object.assign(new Error("unavailable"), { status: 503 }) }),
  })
  assert.equal(identity, null)
  assert.equal(responseStatus, 503)
  assert.deepEqual(responseBody, {
    error: "auth_provider_unavailable",
    code: "auth_provider_unavailable",
    retryable: true,
    providerFailureClass: "provider_5xx",
  })
  assert.doesNotMatch(JSON.stringify(responseBody), /Bearer|signature|access-token/)
})

test("wrong private subject fails closed", async () => {
  const wrong = "00000000-0000-4000-8000-000000000002"
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor({ sub: wrong })), {
      env,
      ...clients({ authUserId: wrong }),
    }),
    { code: "private_account_mismatch" },
  )
})

test("inactive and missing companions fail closed", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor()), { env, ...clients({ companion: "suspended" }) }),
    { code: "companion_inactive" },
  )
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor()), { env, ...clients({ companion: "missing" }) }),
    { code: "companion_missing" },
  )
})

test("companion lookup database errors fail closed", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor()), {
      env,
      ...clients({ companionError: "database unavailable" }),
    }),
    { code: "companion_lookup_failed", status: 503 },
  )
})

test("companion lifecycle lookup uses the canonical schema column", () => {
  const resolver = fs.readFileSync("lib/requestIdentity.js", "utf8")
  assert.match(resolver, /\.select\("user_id,lifecycle_status"\)/)
  assert.match(resolver, /data\.lifecycle_status !== "active"/)
  assert.doesNotMatch(resolver, /\.select\("user_id,status"\)/)
  assert.doesNotMatch(resolver, /data\.status/)
})

test("forged legacy owner and any supplied UUID are rejected", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor(), { user_id: "small_c" }), { env, ...clients() }),
    { code: "legacy_user_id_mismatch" },
  )
  await assert.rejects(
    resolveRequestIdentity(request(tokenFor(), { user_id: "user", user_uuid: PRIVATE_AUTH_USER_UUID }), {
      env,
      ...clients(),
    }),
    { code: "client_user_uuid_forbidden" },
  )
})

test("JWT verification failure never falls back to a valid app token", async () => {
  const fallbackEnv = {
    ...env,
    PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true",
    XIAOC_APP_TOKEN: "a".repeat(48),
  }
  const req = request(tokenFor())
  req.headers["x-xiaoc-app-token"] = fallbackEnv.XIAOC_APP_TOKEN
  await assert.rejects(
    resolveRequestIdentity(req, { env: fallbackEnv, ...clients({ authError: "invalid" }) }),
    { code: "invalid_access_token" },
  )
})

test("explicit app-token fallback maps only to the fixed server identity", async () => {
  const fallbackEnv = {
    ...env,
    PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true",
    XIAOC_APP_TOKEN: "a".repeat(48),
  }
  const req = request(null)
  req.headers["x-xiaoc-app-token"] = fallbackEnv.XIAOC_APP_TOKEN
  const identity = await resolveRequestIdentity(req, { env: fallbackEnv, ...clients() })
  assert.equal(identity.authUserId, PRIVATE_AUTH_USER_UUID)
  assert.equal(identity.legacyUserId, "user")
  assert.equal(identity.identitySource, "private_app_fixed_binding_fallback")
})

test("enabled fallback distinguishes a missing app token from an invalid one", async () => {
  const fallbackEnv = {
    ...env,
    PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true",
    XIAOC_APP_TOKEN: "a".repeat(48),
  }
  await assert.rejects(
    resolveRequestIdentity(request(null), { env: fallbackEnv, ...clients() }),
    { code: "authentication_required" },
  )
  const invalidRequest = request(null)
  invalidRequest.headers["x-xiaoc-app-token"] = "wrong"
  await assert.rejects(
    resolveRequestIdentity(invalidRequest, { env: fallbackEnv, ...clients() }),
    { code: "invalid_private_app_token" },
  )
})

test("disabled fallback never restores legacy app-token authentication", async () => {
  const req = request(null)
  req.headers["x-xiaoc-app-token"] = "a".repeat(48)
  await assert.rejects(
    resolveRequestIdentity(req, {
      env: { ...env, XIAOC_APP_TOKEN: "a".repeat(48) },
      ...clients(),
    }),
    { code: "authentication_required" },
  )
})

test("verified JWT remains authoritative regardless of app-token state", async () => {
  const fallbackEnv = {
    ...env,
    PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true",
    XIAOC_APP_TOKEN: "a".repeat(48),
  }
  for (const supplied of [null, "wrong", fallbackEnv.XIAOC_APP_TOKEN]) {
    const req = request(tokenFor())
    if (supplied) req.headers["x-xiaoc-app-token"] = supplied
    const identity = await resolveRequestIdentity(req, { env: fallbackEnv, ...clients() })
    assert.equal(identity.identitySource, "verified_supabase_jwt")
  }
})

test("anonymous compatibility is not accepted", async () => {
  await assert.rejects(
    resolveRequestIdentity(request(null), { env, ...clients() }),
    { code: "authentication_required" },
  )
})

test("all 12 API Functions use the shared async identity resolver", () => {
  const files = fs.readdirSync("api").filter(name => name.endsWith(".js"))
  assert.equal(files.length, 12)
  for (const file of files) {
    const source = fs.readFileSync(`api/${file}`, "utf8")
    assert.match(source, /requireRequestIdentity/)
    assert.match(source, /if \(!await requireRequestIdentity\(req, res\)\) return/)
  }
})

test("server package preserves legacy runtime ownership and internal fallback callers", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memory = fs.readFileSync("api/memory.js", "utf8")
  assert.match(chat, /user_id = APP_USER\.defaultUserId/)
  assert.match(chat, /\.\.\.privateAppInternalHeaders\(\)/)
  assert.match(memory, /task\.user_id/)
  assert.doesNotMatch(memory, /req\.identity\.authUserId\s*=/)
})
