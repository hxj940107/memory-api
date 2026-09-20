import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  authenticatedSelfCallHeaders,
  PRIVATE_APP_TOKEN_HEADER,
} from "../lib/privateAppAuth.js"

const verifiedIdentity = {
  actorType: "authenticated_user",
  authUserId: "cfcf4218-3af2-4210-ada2-566a4d64947d",
  legacyUserId: "user",
  identitySource: "verified_supabase_jwt",
  companionStatus: "active",
}

test("verified owner JWT is forwarded unchanged without requiring app-token fallback", () => {
  const authorization = "Bearer header.payload.signature"
  const headers = authenticatedSelfCallHeaders({
    identity: verifiedIdentity,
    headers: { authorization },
  }, {})

  assert.equal(headers.Authorization, authorization)
  assert.equal(headers[PRIVATE_APP_TOKEN_HEADER], undefined)
})

test("verified JWT forwarding preserves preview protection but never includes the legacy app token", () => {
  const headers = authenticatedSelfCallHeaders({
    identity: verifiedIdentity,
    headers: { Authorization: "Bearer verified.jwt.value" },
  }, {
    XIAOC_APP_TOKEN: "a".repeat(48),
    VERCEL_ENV: "preview",
    PRIVATE_PREVIEW_VERCEL_PROTECTION_BYPASS_SECRET: "preview-bypass",
  })

  assert.equal(headers.Authorization, "Bearer verified.jwt.value")
  assert.equal(headers[PRIVATE_APP_TOKEN_HEADER], undefined)
  assert.equal(headers["x-vercel-protection-bypass"], "preview-bypass")
})

test("verified identity fails closed when the original Bearer header is unavailable or malformed", () => {
  for (const authorization of [undefined, "", "Basic abc", "Bearer", "Bearer   ", ["Bearer a", "Bearer b"]]) {
    assert.throws(
      () => authenticatedSelfCallHeaders({
        identity: verifiedIdentity,
        headers: authorization === undefined ? {} : { authorization },
      }, {}),
      { code: "verified_user_authorization_missing" },
    )
  }
})

test("cron identity is never forwarded as an authenticated-user Bearer", () => {
  const headers = authenticatedSelfCallHeaders({
    identity: {
      actorType: "cron",
      identitySource: "vercel_cron",
    },
    headers: { authorization: "Bearer cron-secret" },
  }, {})

  assert.equal(headers.Authorization, undefined)
})

test("legacy app-token compatibility remains available for the existing fallback identity", () => {
  const token = "b".repeat(48)
  const headers = authenticatedSelfCallHeaders({
    identity: {
      actorType: "authenticated_user",
      identitySource: "private_app_fixed_binding_fallback",
    },
    headers: { [PRIVATE_APP_TOKEN_HEADER]: token },
  }, { XIAOC_APP_TOKEN: token })

  assert.equal(headers[PRIVATE_APP_TOKEN_HEADER], token)
  assert.equal(headers.Authorization, undefined)
})

test("chat explicitly propagates the verified self-call headers to both messages and summary", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")

  assert.match(source, /if \(!await requireRequestIdentity\(req, res\)\) return\s+try \{\s+const selfCallHeaders = authenticatedSelfCallHeaders\(req\)/)
  assert.match(source, /saveUserMessage\([\s\S]*?userVoice,\s+selfCallHeaders,\s*\)/)
  assert.match(source, /const assistantMessageId = await saveMessage\([\s\S]*?selfCallHeaders,\s*\)/)
  assert.match(source, /`\$\{process\.env\.BASE_URL\}\/api\/update-summary`[\s\S]*?"Content-Type": "application\/json",\s+\.\.\.selfCallHeaders/)

  assert.doesNotMatch(source, /Authorization:\s*[^\n]*(authUserId|user_uuid|user_id)/)
  assert.doesNotMatch(source, /metadata:\s*\{[^}]*Authorization/s)
})

test("downstream handlers retain independent fail-closed identity validation", () => {
  for (const file of ["api/add-message.js", "api/update-summary.js"]) {
    const source = fs.readFileSync(file, "utf8")
    assert.match(source, /if \(!await requireRequestIdentity\(req, res\)\) return/)
  }
})

test("Bearer values are confined to request headers and never enter logs, errors, or metadata", () => {
  const helperSource = fs.readFileSync("lib/privateAppAuth.js", "utf8")
  const chatSource = fs.readFileSync("api/chat.js", "utf8")

  assert.doesNotMatch(helperSource, /console\.(?:log|warn|error)/)
  assert.doesNotMatch(chatSource, /console\.(?:log|warn|error)\([^\n]*selfCallHeaders/)
  assert.doesNotMatch(chatSource, /metadata\s*:\s*\{[^}]*selfCallHeaders/s)

  const secret = "do-not-disclose-this-value"
  assert.throws(
    () => authenticatedSelfCallHeaders({
      identity: verifiedIdentity,
      headers: { authorization: `Basic ${secret}` },
    }, {}),
    error => error.code === "verified_user_authorization_missing"
      && !error.message.includes(secret),
  )
})
