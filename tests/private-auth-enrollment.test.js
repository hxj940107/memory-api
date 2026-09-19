import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const ts = require("../mobile/XiaoC/node_modules/typescript")
const sourcePath = path.resolve("mobile/XiaoC/src/lib/supabaseAuth.ts")
const targetUserId = "94000000-0000-4000-8000-000000000001"

function session(overrides = {}) {
  return {
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: targetUserId },
    ...overrides,
  }
}

function loadAuth(client, options = {}) {
  const owner = Object.prototype.hasOwnProperty.call(options, "owner")
    ? options.owner
    : targetUserId
  const previous = {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    enrollment: process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED,
    owner: process.env.EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID,
  }
  process.env.EXPO_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co"
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key"
  process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED = "true"
  if (owner === undefined) delete process.env.EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID
  else process.env.EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID = owner
  const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const secureValues = new Map()
  const secureStore = {
    async getItemAsync(key) { return secureValues.get(key) ?? null },
    async setItemAsync(key, value) { secureValues.set(key, value) },
    async deleteItemAsync(key) { secureValues.delete(key) },
  }
  const localRequire = name => {
    if (name === "@supabase/supabase-js") return { createClient: () => client }
    if (name === "expo-secure-store") return secureStore
    return require(name)
  }
  new Function("require", "module", "exports", output)(localRequire, module, module.exports)
  process.env.EXPO_PUBLIC_SUPABASE_URL = previous.url
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = previous.key
  process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED = previous.enrollment
  if (previous.owner === undefined) delete process.env.EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID
  else process.env.EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID = previous.owner
  return { api: module.exports, secureValues }
}

test("private enrollment accepts only the approved Auth account", async () => {
  const calls = []
  const client = {
    auth: {
      async signInWithPassword(input) {
        calls.push(input)
        return { data: { session: session() }, error: null }
      },
      async signOut() { assert.fail("correct account must remain enrolled") },
    },
  }
  const { api } = loadAuth(client)
  const result = await api.enrollPrivateAuthAccount(" private@example.com ", "not-logged")
  assert.equal(result.userId, targetUserId)
  assert.deepEqual(calls, [{ email: "private@example.com", password: "not-logged" }])
})

test("wrong account is removed locally and fails closed", async () => {
  let signOutOptions = null
  const client = {
    auth: {
      async signInWithPassword() {
        return { data: { session: session({ user: { id: "00000000-0000-4000-8000-000000000002" } }) }, error: null }
      },
      async signOut(options) { signOutOptions = options },
    },
  }
  const { api } = loadAuth(client)
  await assert.rejects(api.enrollPrivateAuthAccount("x@example.com", "secret"), /Unexpected XiaoC Auth account/)
  assert.deepEqual(signOutOptions, { scope: "local" })
})

test("missing and malformed mobile owner configuration fail explicitly", async () => {
  const client = {
    auth: {
      async signInWithPassword() { return { data: { session: session() }, error: null } },
      async signOut() {},
    },
  }
  const missing = loadAuth(client, { owner: undefined }).api
  await assert.rejects(
    missing.enrollPrivateAuthAccount("x@example.com", "secret"),
    /owner is not configured/i,
  )
  const malformed = loadAuth(client, { owner: "not-a-uuid" }).api
  await assert.rejects(
    malformed.enrollPrivateAuthAccount("x@example.com", "secret"),
    /owner configuration is invalid/i,
  )
})

test("a staging build can configure a different expected owner", async () => {
  const stagingOwner = "95000000-0000-4000-8000-000000000002"
  const client = {
    auth: {
      async signInWithPassword() {
        return { data: { session: session({ user: { id: stagingOwner } }) }, error: null }
      },
      async signOut() { assert.fail("configured staging owner must remain enrolled") },
    },
  }
  const { api } = loadAuth(client, { owner: stagingOwner })
  assert.equal((await api.enrollPrivateAuthAccount("x@example.com", "secret")).userId, stagingOwner)
})

test("near-expiry access token is refreshed before an API request uses it", async () => {
  let refreshes = 0
  const client = {
    auth: {
      async getSession() {
        return { data: { session: session({ access_token: "old", expires_at: 1 }) }, error: null }
      },
      async refreshSession() {
        refreshes += 1
        return { data: { session: session({ access_token: "fresh" }) }, error: null }
      },
      async signOut() {},
    },
  }
  const { api } = loadAuth(client)
  assert.equal(await api.getPrivateAccessToken(), "fresh")
  assert.equal(refreshes, 1)
})

test("concurrent near-expiry token requests share one refresh and one access token", async () => {
  let refreshes = 0
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const client = {
    auth: {
      async getSession() {
        return { data: { session: session({ access_token: "old", expires_at: 1 }) }, error: null }
      },
      async refreshSession() {
        refreshes += 1
        await refreshGate
        return { data: { session: session({ access_token: "shared-fresh" }) }, error: null }
      },
      async signOut() {},
    },
  }
  const { api } = loadAuth(client)
  const firstTen = Array.from({ length: 10 }, () => api.getPrivateAccessToken())
  await new Promise(resolve => setImmediate(resolve))
  const nextTen = Array.from({ length: 10 }, () => api.getPrivateAccessToken())
  assert.equal(refreshes, 1)
  releaseRefresh()
  assert.deepEqual(await Promise.all([...firstTen, ...nextTen]), Array(20).fill("shared-fresh"))
  assert.equal(refreshes, 1)
})

test("refresh failure is shared, clears single-flight state, and permits a later retry", async () => {
  let refreshes = 0
  let fail = true
  const client = {
    auth: {
      async getSession() {
        return { data: { session: session({ access_token: "old", expires_at: 1 }) }, error: null }
      },
      async refreshSession() {
        refreshes += 1
        await new Promise(resolve => setImmediate(resolve))
        return fail
          ? { data: { session: null }, error: new Error("temporary") }
          : { data: { session: session({ access_token: "recovered" }) }, error: null }
      },
      async signOut() {},
    },
  }
  const { api } = loadAuth(client)
  const failures = await Promise.allSettled(
    Array.from({ length: 20 }, () => api.getPrivateAccessToken()),
  )
  assert.equal(refreshes, 1)
  assert.ok(failures.every(result => result.status === "rejected"))
  assert.equal(new Set(failures.map(result => result.reason.message)).size, 1)

  fail = false
  assert.equal(await api.getPrivateAccessToken(), "recovered")
  assert.equal(refreshes, 2)
})

test("fresh access tokens never trigger an explicit refresh", async () => {
  let refreshes = 0
  const client = {
    auth: {
      async getSession() {
        return { data: { session: session({ access_token: "still-fresh" }) }, error: null }
      },
      async refreshSession() { refreshes += 1; assert.fail("fresh token must not refresh") },
      async signOut() {},
    },
  }
  const { api } = loadAuth(client)
  assert.equal(await api.getPrivateAccessToken(), "still-fresh")
  assert.equal(refreshes, 0)
})

test("session loss is explicit and does not invent an identity", async () => {
  const client = {
    auth: {
      async getSession() { return { data: { session: null }, error: null } },
      async signOut() {},
    },
  }
  const { api } = loadAuth(client)
  assert.equal(await api.hasPrivateAuthSession(), false)
  assert.equal(await api.getPrivateAccessToken(), null)
})

test("session persistence uses chunked SecureStore and enrollment remains private-only", async () => {
  let storage
  const client = { auth: {} }
  const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const secureValues = new Map()
  const module = { exports: {} }
  const localRequire = name => {
    if (name === "@supabase/supabase-js") return {
      createClient(_url, _key, options) { storage = options.auth.storage; return client },
    }
    if (name === "expo-secure-store") return {
      async getItemAsync(key) { return secureValues.get(key) ?? null },
      async setItemAsync(key, value) { secureValues.set(key, value) },
      async deleteItemAsync(key) { secureValues.delete(key) },
    }
    return require(name)
  }
  const previousUrl = process.env.EXPO_PUBLIC_SUPABASE_URL
  const previousKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  process.env.EXPO_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co"
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key"
  new Function("require", "module", "exports", output)(localRequire, module, module.exports)
  process.env.EXPO_PUBLIC_SUPABASE_URL = previousUrl
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = previousKey
  const value = "x".repeat(4200)
  await storage.setItem("session", value)
  assert.equal(await storage.getItem("session"), value)
  assert.ok(secureValues.size >= 4)

  const authSource = fs.readFileSync(sourcePath, "utf8")
  const enrollmentSource = fs.readFileSync("mobile/XiaoC/src/components/PrivateAuthEnrollment.tsx", "utf8")
  assert.doesNotMatch(authSource + enrollmentSource, /console\.(log|warn|error)/)
  assert.doesNotMatch(authSource + enrollmentSource, /signUp|账号切换|注册/)
  assert.match(enrollmentSource, /secureTextEntry/)
  assert.match(enrollmentSource, /setPassword\(""\)/)
  assert.match(authSource, /EXPO_PUBLIC_XIAOC_PRIVATE_AUTH_USER_UUID/)
  assert.doesNotMatch(authSource, /17aa1bd0-931d-40a0-b0d6-ef75c641c7b3/i)
})
