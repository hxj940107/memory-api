import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  PRIVATE_AUTH_USER_UUID,
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

function clients({ authUserId = PRIVATE_AUTH_USER_UUID, authError = null, companion = "active" } = {}) {
  return {
    authClient: {
      auth: {
        async getUser() {
          return authError
            ? { data: { user: null }, error: new Error(authError) }
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
            return companion === "missing"
              ? { data: null, error: null }
              : { data: { user_id: PRIVATE_AUTH_USER_UUID, status: companion }, error: null }
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
    { code: "invalid_access_token" },
  )
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

test("mobile attaches JWT first and preserves legacy alias compatibility", () => {
  const api = fs.readFileSync("mobile/XiaoC/src/config/api.ts", "utf8")
  const auth = fs.readFileSync("mobile/XiaoC/src/lib/supabaseAuth.ts", "utf8")
  assert.match(api, /headers\.set\("Authorization", `Bearer \$\{accessToken\}`\)/)
  assert.match(api, /if \(privateAppToken\)/)
  assert.match(api, /export const APP_USER_ID = "user"/)
  assert.match(auth, /persistSession: true/)
  assert.match(auth, /SecureStore/)
})
