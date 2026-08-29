import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

test("a paid none decision remains quietly visible as seen", () => {
  const api = fs.readFileSync("api/memory.js", "utf8")
  const screen = fs.readFileSync("mobile/XiaoC/src/app/moments.tsx", "utf8")

  assert.match(api, /\.select\("moment_id,seen_at,liked_at"\)/)
  assert.match(api, /xiaocSeen: xiaocSeenMomentIds\.has\(item\.id\)/)
  assert.match(screen, /xiaocSeen: Boolean\(item\.xiaocSeen\)/)
  assert.match(screen, /小C看过了/)
  assert.match(screen, /!moment\.xiaocLiked/)
})
