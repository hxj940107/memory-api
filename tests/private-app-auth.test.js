import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  authorizePrivateAppRequest,
  privateAppInternalHeaders,
} from "../lib/privateAppAuth.js"

const token = "a".repeat(48)

test("private app auth is compatibility-safe until explicitly enabled", () => {
  assert.equal(authorizePrivateAppRequest({ headers: {} }, {}).allowed, true)
  assert.equal(authorizePrivateAppRequest({ headers: {} }, {
    XIAOC_APP_AUTH_ENABLED: "false",
  }).allowed, true)
})

test("enabled auth accepts only the configured private token", () => {
  const env = { XIAOC_APP_AUTH_ENABLED: "true", XIAOC_APP_TOKEN: token }
  assert.equal(authorizePrivateAppRequest({
    headers: { "x-xiaoc-app-token": token },
  }, env).allowed, true)
  assert.equal(authorizePrivateAppRequest({
    headers: { "x-xiaoc-app-token": "wrong" },
  }, env).allowed, false)
})

test("Vercel cron remains authorized independently", () => {
  const env = {
    XIAOC_APP_AUTH_ENABLED: "true",
    XIAOC_APP_TOKEN: token,
    CRON_SECRET: "cron-secret-value-long-enough",
  }
  assert.equal(authorizePrivateAppRequest({
    headers: { authorization: "Bearer cron-secret-value-long-enough" },
  }, env).mode, "vercel_cron")
})

test("server-to-server requests forward the private token", () => {
  assert.deepEqual(privateAppInternalHeaders({ XIAOC_APP_TOKEN: token }), {
    "x-xiaoc-app-token": token,
  })
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /\.\.\.privateAppInternalHeaders\(\)/)
})

test("all public API functions enforce the shared gate", () => {
  const apiFiles = fs.readdirSync("api").filter((name) => name.endsWith(".js"))
  assert.equal(apiFiles.length, 12)
  for (const name of apiFiles) {
    const source = fs.readFileSync(`api/${name}`, "utf8")
    assert.match(source, /requirePrivateAppRequest/, `${name} imports auth gate`)
    assert.match(source, /if \(!requirePrivateAppRequest\(req, res\)\) return/, `${name} invokes auth gate`)
  }
})

test("mobile API requests attach the Keychain-backed token", () => {
  const source = fs.readFileSync("mobile/XiaoC/src/config/api.ts", "utf8")
  assert.match(source, /SecureStore\.getItemAsync\(PRIVATE_APP_TOKEN_KEY\)/)
  assert.match(source, /headers\.set\("X-XiaoC-App-Token", privateAppToken\)/)
})
