import assert from "node:assert/strict"
import fs from "node:fs"
import {
  evaluateDynamicMemorySearchText,
  LEGACY_CORE_MEMORY_BUCKET_IDS,
} from "../lib/dynamicMemoryFilter.js"

{
  const result = evaluateDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n我们的约定: 已经进入 Core 的旧约定\n---\n榴莲复查: 榴莲今天去医院复查，结果需要继续关注`,
    [{ id: LEGACY_CORE_MEMORY_BUCKET_IDS[0], title: "我们的约定", content: "已经进入 Core 的旧约定" }]
  )

  assert.doesNotMatch(result.text, /我们的约定/)
  assert.match(result.text, /榴莲复查/)
}

{
  const fullCoreContent = `她需要我记住：${"这是确定属于 Core 的正文。".repeat(20)}`
  const truncatedSearchContent = fullCoreContent.slice(0, 120)
  const result = evaluateDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n旧标题: ${truncatedSearchContent}\n---\n旅行计划: 她明天准备去旅行`,
    [{ id: "core-source-id", title: "新标题", content: fullCoreContent }]
  )

  assert.doesNotMatch(result.text, /旧标题/)
  assert.match(result.text, /旅行计划/)
}

{
  const result = evaluateDynamicMemorySearchText(
    `[Ombre Brain - 相关记忆]\n工作: 今天工作很忙\n---\n工作: 今天工作很忙`,
    []
  )
  assert.equal((result.text.match(/今天工作很忙/g) || []).length, 1)
}

{
  const search = `[Ombre Brain - 相关记忆]\n午餐: 她今天中午吃了咖喱牛肉\n---\n旅行: 她去年独自去了日本旅行`
  const suppressed = evaluateDynamicMemorySearchText(search, [], {
    recentTexts: ["她今天中午吃了咖喱牛肉，味道很好"],
    currentMessage: "我准备午休了",
  })
  assert.doesNotMatch(suppressed.text, /咖喱牛肉/)
  assert.match(suppressed.text, /日本旅行/)

  const restored = evaluateDynamicMemorySearchText(search, [], {
    recentTexts: ["她今天中午吃了咖喱牛肉，味道很好"],
    currentMessage: "我又想起今天中午的咖喱牛肉了",
  })
  assert.match(restored.text, /咖喱牛肉/)
}

{
  assert.equal(LEGACY_CORE_MEMORY_BUCKET_IDS.length, 5)
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /coreMemorySnapshot\.sourceBucketIds/)
  assert.match(chat, /fetchCompleteMemoriesByIds\(excludedBucketIds\)/)
  assert.match(chat, /dynamic memory exclusion load failed; injection skipped/)
}

console.log("dynamic memory filter tests passed")
