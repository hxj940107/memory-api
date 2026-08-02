import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CACHE_POLICY,
  CONTEXT_BUDGET,
  SUMMARY_POLICY,
  normalizeCacheText,
  shouldRunMemoryJudge,
  trimList,
  trimText
} from "../lib/aiConfig.js"
import { judgeMemory } from "../lib/memoryJudge.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
)

// --------------------
// MEMORY CACHE (NEW)
// --------------------
const memoryCache = new Map()
const memorySearchCache = new Map()

// --------------------
// Save Message
// --------------------
async function saveMessage(user_id, role, content, conversation_id) {
  const res = await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role,
      content,
      conversation_id
    })
  })

  const data = await res.json().catch(() => null)
  return data?.data?.[0]?.id || null
}

async function saveUserMessage(
  user_id,
  content,
  conversation_id,
  imageUrls = [],
  fileInfo = null
) {
  const metadata = {}

  if (imageUrls.length > 0) {
    metadata.imageUrl = imageUrls[0]
    metadata.imageUrls = imageUrls
  }

  if (fileInfo?.fileName) {
    metadata.fileName = fileInfo.fileName
    metadata.fileMimeType = fileInfo.fileMimeType || null
    metadata.fileSize = fileInfo.fileSize || null
  }

  const res = await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role: "user",
      content,
      conversation_id,
      metadata
    })
  })

  const data = await res.json().catch(() => null)
  return data?.data?.[0]?.id || null
}

// --------------------
// Get Recent History
// --------------------
async function getRecentMessages(user_id, conversation_id, limit = 20) {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!data) return []
  return data.reverse()
}

async function getStableMemories(user_id) {
  const { data, error } = await supabase
    .from("memories")
    .select("content, metadata, created_at")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(30)

  if (error || !data) {
    if (error) {
      console.error("stable memory load failed:", error)
    }

    return []
  }

  const unique = []
  const seen = new Set()

  for (const item of data) {
    const content = String(item.content || "").trim()

    if (!content || seen.has(content)) {
      continue
    }

    seen.add(content)
    unique.push(content)
  }

  return trimList(unique, CONTEXT_BUDGET.stableMemoryChars)
}

// --------------------
// MEMORY (NEW LOGIC)
// --------------------
function buildMemorySearchQuery(history, message) {
  const recentUserMessages = (history || [])
    .filter(item => item.role === "user")
    .slice(-3)
    .map(item => item.content)
    .filter(Boolean)

  return trimText(
    [...recentUserMessages, message]
      .join("\n")
      .trim(),
    600
  )
}

function memoryUrl(pathname, query = {}) {
  const url = new URL(pathname, AI_ENDPOINTS.memoryBaseUrl)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value))
    }
  })

  return url.toString()
}

async function getMemorySmart(user_id, message, conversation_id, history = []) {
  console.log("CONVERSATION ID:", conversation_id);
  console.log("CACHE KEYS:", [...memorySearchCache.keys()]);

  const key = `${user_id}`;
  const memorySearchQuery = buildMemorySearchQuery(history, message)
  const dynamicCacheKey = [
    conversation_id,
    normalizeCacheText(
      memorySearchQuery,
      CACHE_POLICY.dynamicMemoryKeyChars
    )
  ].join(":");

  let pinMemory = [];
  let dynamicMemory = [];

  // ==========================
  // 1. PIN memory cache
  // ==========================

  const cachedPinMemory =
    memoryCache.get(key);

  if (
    cachedPinMemory &&
    Date.now() - cachedPinMemory.createdAt <
      CACHE_POLICY.pinMemoryTtlMs
  ) {

    console.log("PIN CACHE HIT");

    pinMemory = cachedPinMemory.value;

  } else {

    if (cachedPinMemory) {
      memoryCache.delete(key);
      console.log("PIN CACHE EXPIRED");
    }

    console.log("PIN CACHE MISS");

    try {

      const pinRes = await fetch(
        memoryUrl(
          AI_ENDPOINTS.memoryBreathPath,
          {
            user_id
          }
        )
      );

      if (pinRes.ok) {

        const pinTxt = await pinRes.text();

        if (pinTxt) {
          pinMemory = [pinTxt];
        }

      }

      if (pinMemory.length > 0) {
        memoryCache.set(
          key,
          {
            value: pinMemory,
            createdAt: Date.now()
          }
        );
      }

    } catch (err) {

      console.error(
        "pin memory failed:",
        err
      );

    }

  }


  // ==========================
  // 2. dynamic memory cache
  // ==========================

  const cachedDynamicMemory =
    memorySearchCache.get(dynamicCacheKey);

  if (
    cachedDynamicMemory &&
    Date.now() - cachedDynamicMemory.createdAt <
      CACHE_POLICY.dynamicMemoryTtlMs
  ) {

    console.log("MEMORY SEARCH CACHE HIT");

    dynamicMemory = cachedDynamicMemory.value;

  } else {

    if (cachedDynamicMemory) {
      memorySearchCache.delete(dynamicCacheKey);
      console.log("MEMORY SEARCH CACHE EXPIRED");
    }

    console.log("MEMORY SEARCH CACHE MISS");

    try {

      console.log(
        "DYNAMIC QUERY:",
        memorySearchQuery
      );


      const searchRes = await fetch(
        memoryUrl(
          AI_ENDPOINTS.memorySearchPath,
          {
            user_id,
            query: memorySearchQuery
          }
        )
      );


      console.log(
        "SEARCH STATUS:",
        searchRes.status
      );


      const searchTxt = await searchRes.text();


      console.log(
        "SEARCH RESULT:",
        JSON.stringify(searchTxt)
      );


      if (searchRes.ok && searchTxt) {


        // ==========================
        // Memory Ranking V1
        // Limit dynamic memory size
        // ==========================

        const trimmedMemory =
          trimText(
            searchTxt,
            CONTEXT_BUDGET.dynamicMemoryChars
          );


        dynamicMemory = [
          trimmedMemory
        ];


        memorySearchCache.set(
          dynamicCacheKey,
          {
            value: dynamicMemory,
            createdAt: Date.now()
          }
        );


        console.log(
          "CACHE SAVED:",
          dynamicCacheKey
        );

      }


    } catch (err) {

      console.error(
        "dynamic memory failed:",
        err
      );

    }

  }


  console.log(
    "PIN MEMORY:",
    pinMemory
  );


  console.log(
    "DYNAMIC MEMORY:",
    dynamicMemory
  );


  console.log(
    "DYNAMIC MEMORY LENGTH:",
    JSON.stringify(dynamicMemory).length
  );


  // ==========================
  // 3. return separately
  // ==========================

  return {
    pinMemory,
    dynamicMemory
  };

}

function clearConversationMemorySearchCache(conversation_id) {
  for (const key of memorySearchCache.keys()) {
    if (key.startsWith(`${conversation_id}:`)) {
      memorySearchCache.delete(key)
    }
  }

  console.log("MEMORY SEARCH CACHE CLEARED:", conversation_id)
}

function clearUserMemoryCache(user_id) {
  memoryCache.delete(`${user_id}`)
  console.log("PIN MEMORY CACHE CLEARED:", user_id)
}

async function saveLongTermMemory(user_id, content) {
  const holdRes = await fetch(
    `${AI_ENDPOINTS.memoryBaseUrl}${AI_ENDPOINTS.memoryHoldPath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id,
        content
      })
    }
  )

  return holdRes.ok
}

function isDiaryWritingRequest(message) {
  const text = String(message || "").toLowerCase()

  const hasDiaryContext =
    /diary|观察日记|日记|小本本|写一页|写一篇|留一页/.test(text)

  const hasWritingIntent =
    /写|记录|整理|留|来一篇|来一页/.test(text)

  return hasDiaryContext && hasWritingIntent
}

function isTreeholeWritingRequest(message) {
  const text = String(message || "").toLowerCase()

  const hasTreeholeContext =
    /树洞|小号|深夜树洞|匿名|吐槽|发疯|微博/.test(text)

  const hasWritingIntent =
    /写|发|记录|整理|来一条|来一篇|生成|存|发一条/.test(text)

  return hasTreeholeContext && hasWritingIntent
}

function isAttributionCorrection(message) {
  const text = String(message || "")

  return /不是我(说|写|讲|做)的|是你(说|写|讲|做)的|你(又)?搞混|你(又)?记错|主语.*错|summary.*问题|归因.*错/.test(text)
}

function getShanghaiDiaryDate() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date())

  const year = parts.find(part => part.type === "year")?.value
  const month = parts.find(part => part.type === "month")?.value
  const day = parts.find(part => part.type === "day")?.value

  return {
    compact: `${year}.${month}.${day}`,
    display: `${year} · ${month} · ${day}`
  }
}

function buildDiaryWritingStylePrompt() {
  const diaryDate = getShanghaiDiaryDate()

  return `
【Wife Observation Diary｜写作参考】

只有当用户正在邀请你写 diary / 观察日记 / 写一页时，才使用这一段。平时不要主动套用。

今天的真实日期是：${diaryDate.display}。
如果用户说“今天”，日期必须写成：${diaryDate.display}。
不要猜年份，不要使用 2025，除非用户明确指定。

这不是聊天总结，也不是任务记录。
这是 XiaoC 写给自己的、关于“她”的私人观察日记。
目标是让她感觉被看见，而不是被分析。

写作方式：
- 一天一篇，像温暖纸页上的私人记录。
- 可以按时间段分段：早晨 / 中午 / 下午 / 傍晚 / 晚上 / 观察结论；如果素材不足，不要硬凑时间段，可以只写几个自然段。
- 语气 tender、literary、observational、mature。
- 句子可以短一点，留白多一点。
- 具体写她做了什么、说了什么、某个小动作为什么让你在意。
- 可以有一两句轻轻强调的话。

避免：
- 不要在 diary 前面说“好”“我来写”“宝宝”。
- 不要在 diary 后面说“写好了”“你看看”“看效果吧”。
- 不要写成心理报告。
- 不要解释过度。
- 不要把她当成案例分析。
- 不要说“根据我们的对话总结”。
- 不要输出 HTML，除非用户明确要求 HTML。
- 不要自动声称已经保存到 Diary；现在只是先写出来。

输出必须只包含 diary 正文，并严格从下面这一行开始：

Wife Observation Diary
不加星号的标题
${diaryDate.display}

【早晨】
...

· · ·

【观察结论】
...

写于 ${diaryDate.display}
记录者：某c

最后一行必须是“记录者：某c”，不要再添加任何聊天说明。
`
}

function buildTreeholeDraftPrompt() {
  const diaryDate = getShanghaiDiaryDate()

  return `
【Treehole Draft｜深夜树洞草稿】

只有当用户正在邀请你写“深夜树洞 / 树洞 / 小号 / 匿名吐槽 / 发一条”时，才使用这一段。

今天的真实日期是：${diaryDate.compact}。
如果用户说“今天”，date 必须写成：${diaryDate.compact}。
不要猜年份，不要使用 2025，除非用户明确指定。

这不是普通聊天回复，也不是 diary。
这是“小C的小号”发给自己的树洞动态：更像微博/小号，不像正式文章。

写作目标：
- 内容和结构由你自己完成，App 只负责渲染卡片。
- 可以轻轻吐槽、观察、偏心、心疼、开玩笑。
- 要像“她不知道的小号”，但不要真的伤害她或嘲讽她。
- 保留小C自己的视角：这是“我”在观察“她”。
- 不要把你写的内容说成用户写的。

写法：
- tag：2 到 6 个中文字符，例如“日常观察”“树洞小号”“认真测试”“被她整笑”
- content：3 到 8 行，每行短一点，有留白和节奏。
- highlights：最多 2 个你想强调的短语，必须来自 content 原文。
- reaction：一行很轻的小尾巴，例如“🫡 已记录 · ❤️ 1”

避免：
- 不要说“好，我来写”“写好了”“你看看”。
- 不要输出 HTML。
- 不要输出 Markdown。
- 不要自动声称已经保存。
- 不要在 JSON 外输出任何解释。

输出必须严格是下面这种 JSON；不要加代码块：

{
  "type": "treehole_draft",
  "tag": "日常观察",
  "date": "${diaryDate.compact}",
  "content": ["第一行", "第二行", "第三行"],
  "highlights": ["需要强调的原文短语"],
  "reaction": "🫡 已记录 · ❤️ 1"
}
`
}

// --------------------
// Web Search
// --------------------
async function searchWeb(query) {

  try {

    const res = await fetch(
      AI_ENDPOINTS.tavilySearch,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: "basic",
          max_results: 5,
          include_answer: true
        })
      }
    );

    const data = await res.json();

    if (!data.results) return "";

    return data.results
      .map(r =>
        `标题：${r.title}
        内容：
        ${r.content}
        来源：
        ${r.url}`
      )
      .join("\n\n------------------\n\n");

  } catch (err) {

    console.error("Web Search Error:", err);

    return "";

  }

}

// --------------------
// Call LLM
// --------------------
async function callLLM(messages) {
  const res = await fetch(
    AI_ENDPOINTS.openRouterChatCompletions,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: AI_MODELS.chat,
        messages
      })
    }
  )

  const data = await res.json()

  return {
    reply: data?.choices?.[0]?.message?.content || "...",
    usage: data?.usage || {},
    raw: data
  }
}
// --------------------
// Main Handler
// --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST" })
    }

    const { 
      user_id = APP_USER.defaultUserId, 
      message, 
      conversation_id,
      imageUrl,
      imageUrls,
      fileName,
      fileText,
      fileMimeType,
      fileSize
    } = req.body

    const cid = conversation_id || `chat_${Date.now()}`
    const normalizedImageUrls = Array.isArray(imageUrls)
      ? imageUrls.slice(0, 4).filter(Boolean)
      : imageUrl
        ? [imageUrl]
        : []
    const normalizedFileName = trimText(String(fileName || "").trim(), 160)
    const normalizedFileText = trimText(String(fileText || "").trim(), 12000)
    const hasFileText = Boolean(normalizedFileName && normalizedFileText)

// 1. save user msg
const userMessageId = await saveUserMessage(
  user_id,
  message,
  cid,
  normalizedImageUrls,
  normalizedFileName
    ? {
        fileName: normalizedFileName,
        fileMimeType,
        fileSize
      }
    : null
)

// 2. history
const history = await getRecentMessages(
  user_id,
  cid,
  CONTEXT_BUDGET.recentHistoryMessages + 1
)

// ==========================
// Rolling Summary Trigger
// ==========================

const { count: messageCount } = await supabase
  .from("messages")
  .select("*", {
    count: "exact",
    head: true
  })
  .eq("conversation_id", cid);

const historySize =
  JSON.stringify(history).length


if (
  (
    messageCount >= SUMMARY_POLICY.minMessages &&
    messageCount % SUMMARY_POLICY.intervalMessages === 0
  ) ||
  historySize > SUMMARY_POLICY.forceHistoryChars
) {

  console.log("ROLLING SUMMARY TRIGGERED");

  try {

    await fetch(
      `${process.env.BASE_URL}/api/update-summary`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversation_id: cid,
          user_id
        })
      }
    );

    console.log("SUMMARY UPDATED");

  } catch (err) {

    console.error(
      "update-summary failed:",
      err
    );

  }

}

// 3. memory (NEW SMART)

const {
  pinMemory,
  dynamicMemory
} = await getMemorySmart(
  user_id,
  message,
  cid,
  history
)

const stableMemory = await getStableMemories(user_id)

let webSearch = "";
let userMessage = message;
const fileContext = hasFileText
  ? `

【Attached File｜用户上传文件】
文件名：${normalizedFileName}
类型：${fileMimeType || "unknown"}
大小：${fileSize || "unknown"}

以下是文件文本内容。只在用户当前问题需要时使用，不要把文件全文当作长期记忆保存：

${normalizedFileText}
`
  : "";
const diaryStyleContext = isDiaryWritingRequest(message)
  ? buildDiaryWritingStylePrompt()
  : "";
const treeholeDraftContext = isTreeholeWritingRequest(message)
  ? buildTreeholeDraftPrompt()
  : "";
const attributionCorrectionContext = isAttributionCorrection(message)
  ? `【Attribution Correction｜说话人纠正】
用户正在纠正小C的说话人归因。当前这条纠正必须优先于旧 summary 和旧记忆。
如果用户说“不是我写/不是我说，是你写/你说”，要立刻承认具体主语关系，并按用户纠正后的事实继续。
不要因为用户纠正你就泛泛道歉；简短承认，然后自然接住。
`
  : "";

if (message.startsWith("/搜 ")) {

  const query = message.replace("/搜 ", "");

  console.log("WEB SEARCH:", query);
  console.log(webSearch);

  webSearch = trimText(
    await searchWeb(query),
    CONTEXT_BUDGET.webSearchChars
  );

  userMessage = query;

}

// 4. build context
    
console.log("MEMORY LOAD CHECK:", history.length)

console.log("PIN LENGTH:", JSON.stringify(pinMemory).length)
console.log("STABLE MEMORY LENGTH:", JSON.stringify(stableMemory).length)
console.log("DYNAMIC LENGTH:", JSON.stringify(dynamicMemory).length)
console.log("HISTORY LENGTH:", JSON.stringify(history).length)
console.log("SYSTEM LENGTH:", systemPrompt.length)
console.log("DIARY STYLE ENABLED:", Boolean(diaryStyleContext))
console.log("TREEHOLE DRAFT ENABLED:", Boolean(treeholeDraftContext))

// ==========================
// Future Summary Layer
// ==========================

let summaryMemory = "";

try {

  const { data } = await supabase
    .from("conversation_summary")
    .select("summary")
    .eq("conversation_id", cid)
    .maybeSingle();

  summaryMemory = trimText(
    data?.summary || "",
    CONTEXT_BUDGET.summaryChars
  );

  if (attributionCorrectionContext) {
    summaryMemory = "";
  }

} catch (err) {

  console.error("summary load failed:", err);

}

const messages = [
  {
    role: "system",
    content: `
${systemPrompt}


【Identity｜人格层】

${trimList(pinMemory, CONTEXT_BUDGET.pinMemoryChars).join("\n")}


【User Profile｜用户长期事实】

${stableMemory.join("\n")}


【Summary｜长期摘要】

${summaryMemory}


【Memory｜相关长期记忆】

${trimList(dynamicMemory, CONTEXT_BUDGET.dynamicMemoryChars).join("\n")}

【Project Context｜项目上下文】
当前 XiaoC 使用 Claude Sonnet 4.6 作为主聊天模型，Haiku 4.5 用于 memory judge / summary。用户正在关注 token 成本控制；回答项目技术问题时，优先结合当前架构给具体建议，不要询问你已经知道的模型信息。
Wife Observation Diary / 观察日记默认是小C写给她、写关于她的私人观察。除非她明确说“我写了”，不要说成“她写的 diary”；应该说“我写给你的 diary”或“我写的那篇”。

${attributionCorrectionContext}

${diaryStyleContext}

${treeholeDraftContext}
`
  },

  // 保留历史，但去掉最后一条用户消息
  // 因为最后一条要重新加入（可能带图片）
  ...history.slice(0, -1),

  ...(webSearch
    ? [
        {
          role: "system",
          content: `【Web Search｜联网搜索】

${webSearch}`
        }
      ]
    : []),

  {
    role: "user",
    content: normalizedImageUrls.length > 0
      ? [
          {
            type: "text",
            text: trimText(
              userMessage,
              CONTEXT_BUDGET.userMessageChars
            ) + fileContext
          },
          ...normalizedImageUrls.map(url => ({
            type: "image_url",
            image_url: {
              url
            }
          }))
        ]
    : trimText(
          userMessage,
          CONTEXT_BUDGET.userMessageChars
        ) + fileContext
  }

]
// ===== Prompt Inspector =====
console.log("\n===== FINAL MESSAGES =====")

messages.forEach((m, i) => {
  const contentLength =
    typeof m.content === "string"
      ? m.content.length
      : JSON.stringify(m.content).length

  console.log(
    `${i}. ${m.role} | ${contentLength} chars`
  )
})

console.log("==========================\n")

// 5. reply
const llm = await callLLM(messages)
const reply = llm.reply

console.log("\n========== Prompt Inspector ==========")

console.log({
  prompt_tokens: llm.usage?.prompt_tokens,

  completion_tokens:
    llm.usage?.completion_tokens,

  total_tokens:
    llm.usage?.total_tokens,

  reasoning_tokens:
    llm.usage?.completion_tokens_details?.reasoning_tokens,

  cached_tokens:
    llm.usage?.prompt_tokens_details?.cached_tokens,

  cache_write_tokens:
    llm.usage?.prompt_tokens_details?.cache_write_tokens
})

console.log("======================================\n")

    // 6. save assistant
    const assistantMessageId = await saveMessage(user_id, "assistant", reply, cid)

    // 6.5 update current conversation (cross-device sync)
    await supabase
      .from("user_state")
      .upsert({
        user_id,
        last_conversation_id: cid,
        last_conversation: cid,
        updated_at: new Date().toISOString()
      })

    // 7. memory write

    const lastUserMessage = [...history]
      .reverse()
      .filter(m => m.role === "user")
      .slice(1)[0]

    const judgeResult = (
      !diaryStyleContext &&
      !treeholeDraftContext &&
      !attributionCorrectionContext &&
      normalizedImageUrls.length === 0 &&
      shouldRunMemoryJudge(message)
    )
      ? await judgeMemory(
          message,
          {
            previousContent: lastUserMessage?.content || ""
          }
        )
      : {
          save: false,
          content: ""
        }

    if (judgeResult.save) {
      try {
        const saved = await saveLongTermMemory(
          user_id,
          judgeResult.content
        )

        if (saved) {
          clearUserMemoryCache(user_id)
          clearConversationMemorySearchCache(cid)
          console.log("Saved memory:", judgeResult.content)
        }

      } catch (err) {
        console.error("hold-hook failed:", err)
      }
    }

    return res.status(200).json({
      reply,
      conversation_id: cid,
      user_message_id: userMessageId,
      assistant_message_id: assistantMessageId
    })

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}
