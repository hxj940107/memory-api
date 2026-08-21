import assert from "node:assert/strict"
import fs from "node:fs"
import {
  filterDynamicMemorySearchText,
  LEGACY_CORE_MEMORY_BUCKET_IDS,
} from "../lib/dynamicMemoryFilter.js"

{
  const result = filterDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n我们的约定: 已经进入 Core 的旧约定\n---\n榴莲复查: 榴莲今天去医院复查，结果需要继续关注`,
    [{ id: LEGACY_CORE_MEMORY_BUCKET_IDS[0], title: "我们的约定", content: "已经进入 Core 的旧约定" }]
  )

  assert.doesNotMatch(result, /我们的约定/)
  assert.match(result, /榴莲复查/)
}

{
  const fullCoreContent = `她需要我记住：${"这是确定属于 Core 的正文。".repeat(20)}`
  const truncatedSearchContent = fullCoreContent.slice(0, 120)
  const result = filterDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n旧标题: ${truncatedSearchContent}\n---\n旅行计划: 她明天准备去旅行`,
    [{ id: "core-source-id", title: "新标题", content: fullCoreContent }]
  )

  assert.doesNotMatch(result, /旧标题/)
  assert.match(result, /旅行计划/)
}

{
  const result = filterDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n工作: 今天工作很忙\n---\n工作: 今天工作很忙`,
    []
  )
  assert.equal((result.match(/今天工作很忙/g) || []).length, 2)
}

{
  assert.equal(LEGACY_CORE_MEMORY_BUCKET_IDS.length, 5)
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /coreMemorySnapshot\.sourceBucketIds/)
  assert.match(chat, /fetchCompleteMemoriesByIds\(excludedBucketIds\)/)
  assert.match(chat, /dynamic memory exclusion load failed; injection skipped/)
}

console.log("dynamic memory filter tests passed")
