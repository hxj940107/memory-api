import assert from "node:assert/strict"
import fs from "node:fs"

const overview = fs.readFileSync("mobile/XiaoC/src/app/we.tsx", "utf8")
const category = fs.readFileSync("mobile/XiaoC/src/app/we/category.tsx", "utf8")
const detail = fs.readFileSync("mobile/XiaoC/src/app/we/[id].tsx", "utf8")
const api = fs.readFileSync("api/memory.js", "utf8")

for (const source of [overview, category, detail]) {
  assert.match(source, /new Set\(/)
  assert.doesNotMatch(source, /key=\{chip\}/)
}

assert.match(overview, /key=\{category\.id\}/)
assert.doesNotMatch(overview, /key=\{category\.name\}/)
assert.match(overview, /key=\{memory\.id\}/)
assert.match(category, /key=\{memory\.id\}/)
assert.match(api, /WE_MEMORY_CATEGORY_IDS/)
assert.match(api, /id: WE_MEMORY_CATEGORY_IDS\[name\]/)

console.log("memory key tests passed")
