import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CACHE_POLICY,
  CONTEXT_BUDGET,
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
  await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role,
      content,
      conversation_id
    })
  })
}

async function saveUserMessage(user_id, content, conversation_id, imageUrls = []) {
  await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role: "user",
      content,
      conversation_id,
      metadata: imageUrls.length > 0
        ? {
            imageUrl: imageUrls[0],
            imageUrls
          }
        : {}
    })
  })
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

const diaryWritingStylePrompt = `
【Wife Observation Diary｜写作参考】

只有当用户正在邀请你写 diary / 观察日记 / 写一页时，才使用这一段。平时不要主动套用。

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
- 不要写成心理报告。
- 不要解释过度。
- 不要把她当成案例分析。
- 不要说“根据我们的对话总结”。
- 不要输出 HTML，除非用户明确要求 HTML。
- 不要自动声称已经保存到 Diary；现在只是先写出来。

输出可以接近这个结构：

Wife Observation Diary
标题
日期

【早晨】
...

· · ·

【观察结论】
...

写于 今天
记录者：某c
`

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
      imageUrls
    } = req.body

    const cid = conversation_id || `chat_${Date.now()}`
    const normalizedImageUrls = Array.isArray(imageUrls)
      ? imageUrls.slice(0, 4).filter(Boolean)
      : imageUrl
        ? [imageUrl]
        : []

// 1. save user msg
await saveUserMessage(user_id, message, cid, normalizedImageUrls)

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
  messageCount > 20 ||
  historySize > 5000
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
const diaryStyleContext = isDiaryWritingRequest(message)
  ? diaryWritingStylePrompt
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

${diaryStyleContext}
`
  },

  // 保留历史，但去掉最后一条用户消息
  // 因为最后一条要重新加入（可能带图片）
  ...history.slice(0, -1),

  {
    role: "system",
    content: `【Web Search｜联网搜索】

${webSearch}`
  },

  {
    role: "user",
    content: normalizedImageUrls.length > 0
      ? [
          {
            type: "text",
            text: trimText(
              userMessage,
              CONTEXT_BUDGET.userMessageChars
            )
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
        )
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
    await saveMessage(user_id, "assistant", reply, cid)

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

    const judgeResult = shouldRunMemoryJudge(message)
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
      conversation_id: cid
    })

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}
