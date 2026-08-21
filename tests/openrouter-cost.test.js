import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

process.env.SUPABASE_URL ||= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key"
process.env.OPENROUTER_API_KEY ||= "test-openrouter-key"

const { default: userStateHandler } = await import("../api/user-state.js")

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code
    return this
  },
  json(value) {
    this.body = value
    return value
  },
})

test("OpenRouter credits response includes current-key monthly usage", async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls = []

  globalThis.fetch = async url => {
    requestedUrls.push(String(url))

    if (String(url).endsWith("/credits")) {
      return new Response(JSON.stringify({
        data: { total_credits: 34, total_usage: 31.6 },
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      data: { usage_monthly: 12.636332 },
    }), { status: 200 })
  }

  try {
    const response = createResponse()
    await userStateHandler({
      method: "GET",
      query: { user_id: "user", action: "openrouter-credits" },
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body.usage_monthly, 12.636332)
    assert.equal(response.body.total_usage, 31.6)
    assert.ok(Math.abs(response.body.balance - 2.4) < 1e-9)
    assert.deepEqual(requestedUrls.sort(), [
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/key",
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("settings prefers real monthly usage and keeps the local fallback", () => {
  const source = readFileSync("mobile/XiaoC/src/app/settings.tsx", "utf8")

  assert.match(
    source,
    /credits\?\.usage_monthly \?\? summary\.monthCost/,
  )
})

test("credits remain available when current-key usage is unavailable", async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async url => {
    if (String(url).endsWith("/credits")) {
      return new Response(JSON.stringify({
        data: { total_credits: 34, total_usage: 31.6 },
      }), { status: 200 })
    }

    throw new Error("temporary key endpoint failure")
  }

  try {
    const response = createResponse()
    await userStateHandler({
      method: "GET",
      query: { user_id: "user", action: "openrouter-credits" },
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body.total_usage, 31.6)
    assert.equal(response.body.usage_monthly, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
