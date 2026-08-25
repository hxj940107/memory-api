import assert from "node:assert/strict"
import fs from "node:fs"

const detail = fs.readFileSync("mobile/XiaoC/src/app/we/[id].tsx", "utf8")
const list = fs.readFileSync("mobile/XiaoC/src/app/we.tsx", "utf8")
const category = fs.readFileSync("mobile/XiaoC/src/app/we/category.tsx", "utf8")
const api = fs.readFileSync("api/memory.js", "utf8")

assert.match(detail, /const \[content, setContent\] = useState\(initialContent\)/)
assert.match(detail, /const \[editing, setEditing\] = useState\(false\)/)
assert.match(detail, /const \[draftContent, setDraftContent\] = useState\(initialContent\)/)
assert.match(detail, /const nextContent = draftContent\.trim\(\)/)
assert.match(detail, /if \(!nextContent\)/)
assert.match(detail, /action: "update"/)
assert.match(detail, /setContent\(nextContent\)/)
assert.match(detail, /编辑内容还为你保留着/)
assert.match(detail, /\{pinned \? "取消钉选" : "钉选"\}/)
assert.match(detail, /action: "delete"/)
assert.match(detail, /Clipboard\.setStringAsync\(content \|\| title\)/)

assert.match(api, /if \(action === "update"\)/)
assert.match(api, /typeof req\.body\.content !== "string"/)
assert.match(api, /content cannot be empty/)
assert.match(api, /MAX_MEMORY_CONTENT_CHARS = 50_000/)
assert.match(api, /getMemoryUrl\("\/api\/update-content"\)/)
assert.match(api, /Cookie: cookie/)
assert.match(api, /process\.env\.OMBRE_ADMIN_PASSWORD/)
assert.doesNotMatch(detail, /OMBRE_ADMIN_PASSWORD|OMBRE_SESSION_COOKIE/)

assert.match(list, /useFocusEffect/)
assert.match(category, /useFocusEffect/)

console.log("memory editing tests passed")
