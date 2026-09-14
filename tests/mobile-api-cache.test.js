import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

const api = fs.readFileSync("mobile/XiaoC/src/config/api.ts", "utf8")

test("private mobile JSON requests bypass stale HTTP response caches by default", () => {
  assert.match(api, /headers\.set\("Cache-Control", "no-cache"\)/)
  assert.match(api, /cache: fetchOptions\.cache \?\? "no-store"/)
})

test("an explicitly supplied request cache mode remains available", () => {
  assert.match(api, /fetchOptions\.cache \?\? "no-store"/)
  assert.doesNotMatch(api, /cache: "no-store",\s*\.\.\.fetchOptions/)
})

test("structured server delivery metadata is preserved on request failures", () => {
  assert.match(api, /"code" in data[\s\S]*String\(data\.code\)/)
  assert.match(api, /"retryable" in data[\s\S]*data\.retryable === true/)
  assert.match(api, /status: response\.status,[\s\S]*code,[\s\S]*retryable/)
})
