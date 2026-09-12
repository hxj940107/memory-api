import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const ts = require("../mobile/XiaoC/node_modules/typescript")
const sourcePath = path.resolve("mobile/XiaoC/src/lib/supabaseAuth.ts")
const targetUserId = "17aa1bd0-931d-40a0-b0d6-ef75c641c7b3"

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

function loadAuth(client) {
  const previous = {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    enrollment: process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED,
  }
  process.env.EXPO_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co"
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "public-anon-key"
  process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED = "true"
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
})
