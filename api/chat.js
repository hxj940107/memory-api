import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"
import {
  AI_MODELS,
  CACHE_POLICY,
  CONTEXT_BUDGET,
  normalizeCacheText,
  shouldRunMemoryJudge,
  trimList,
  trimText
} from "../lib/aiConfig.js"

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

// --------------------
// Save Memory (raw candidate)
// --------------------
async function saveMemory(user_id, content) {
  await fetch("https://ombre-brain-production-ab16.up.railway.app/hold-hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      content
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

// --------------------
// MEMORY (NEW LOGIC)
// --------------------
async function getMemorySmart(user_id, message, conversation_id) {
  console.log("CONVERSATION ID:", conversation_id);
  console.log("CACHE KEYS:", [...memorySearchCache.keys()]);

  const key = `${user_id}`;
  const dynamicCacheKey = [
    conversation_id,
    normalizeCacheText(
      message,
      CACHE_POLICY.dynamicMemoryKeyChars
    )
  ].join(":");

  let pinMemory = [];
  let dynamicMemory = [];

  // ==========================
  // 1. PIN memory cache
  // ==========================

  if (memoryCache.has(key)) {

    console.log("PIN CACHE HIT");

    pinMemory = memoryCache.get(key);

  } else {

    console.log("PIN CACHE MISS");

    try {

      const pinRes = await fetch(
        "https://ombre-brain-production-ab16.up.railway.app/breath-hook"
      );

      if (pinRes.ok) {

        const pinTxt = await pinRes.text();

        if (pinTxt) {
          pinMemory = [pinTxt];
        }

      }

      // only cache PIN
      memoryCache.set(
        key,
        pinMemory
      );

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
        message
      );


      const searchRes = await fetch(
        "https://ombre-brain-production-ab16.up.railway.app/memory-search?query=" +
        encodeURIComponent(message)
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
// --------------------
// Memory Judge
// --------------------
async function judgeMemory(content, previousContent) {

  try {

    const res = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: AI_MODELS.memoryJudge,
          messages: [
            {
              role: "system",
              content: `
你是长期记忆判断器。

判断下面内容是否值得保存为长期记忆。

值得保存：
- 身份信息
- 人物关系
- 长期计划
- 梦想
- 长期目标
- 喜好
- 性格特点
- 价值观
- 长期困扰
- 重要事件
- 对未来有持续影响的信息

不要保存：
- 寒暄
- 日常闲聊
- 一次性状态
- 临时安排
- 短期提醒
- 今天/今晚/这几天发生的小事
- 无意义内容

如果用户消息包含以下表达：
- 记一下
- 记住
- 保存一下
- 别忘了
- 以后提醒我
- 这个很重要

说明用户主动希望保存。

但是：
用户主动要求保存时，仍然需要判断是否具有长期价值。

如果只是短期事项：
例如：
- 今天早点睡
- 明天买东西
- 晚饭吃什么

不要保存到长期记忆。

只输出 JSON：

{
  "save": true,
  "content": "整理后的长期记忆"
}

如果 save 为 false：
content 必须为空字符串。
例如：

{
  "save": false,
  "content": ""
}
`
            },
            {
              role: "user",
              content: `
当前用户消息：

${content}

上一条用户消息：

${previousContent}
`
            }
          ]
        })
      }
    )
    const data = await res.json()

    let text =
      data?.choices?.[0]?.message?.content || "{}"
    text = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim()

    const clean = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim()

    const jsonStart = clean.indexOf("{")
    const jsonEnd = clean.lastIndexOf("}")

    return JSON.parse(
      clean.slice(jsonStart, jsonEnd + 1)
    )

  } catch (err) {

    console.error(
      "memory judge failed:",
      err
    )

    return {
      save: false,
      content: ""
    }

  }

}

// --------------------
// Web Search
// --------------------
async function searchWeb(query) {

  try {

    const res = await fetch(
      "https://api.tavily.com/search",
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
    "https://openrouter.ai/api/v1/chat/completions",
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
      user_id = "user", 
      message, 
      conversation_id,
      imageUrl
    } = req.body

    const cid = conversation_id || `chat_${Date.now()}`

// 1. save user msg
await saveMessage(user_id, "user", message, cid)

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
          conversation_id: cid
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
  cid
)

let webSearch = "";
let userMessage = message;

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
console.log("DYNAMIC LENGTH:", JSON.stringify(dynamicMemory).length)
console.log("HISTORY LENGTH:", JSON.stringify(history).length)
console.log("SYSTEM LENGTH:", systemPrompt.length)

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


【Summary｜长期摘要】

${summaryMemory}


【Memory｜相关长期记忆】

${trimList(dynamicMemory, CONTEXT_BUDGET.dynamicMemoryChars).join("\n")}
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
    content: imageUrl
      ? [
          {
            type: "text",
            text: trimText(
              userMessage,
              CONTEXT_BUDGET.userMessageChars
            )
          },
          {
            type: "image_url",
            image_url: {
              url: imageUrl
            }
          }
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
          lastUserMessage?.content || ""
        )
      : {
          save: false,
          content: ""
        }

    if (judgeResult.save) {
      try {
        const holdRes = await fetch(
          "https://ombre-brain-production-ab16.up.railway.app/hold-hook",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              user_id,
              content: judgeResult.content
            })
          }
        )

        if (holdRes.ok) {

          for (const key of memorySearchCache.keys()) {
            if (key.startsWith(`${cid}:`)) {
              memorySearchCache.delete(key)
            }
          }

          console.log("MEMORY SEARCH CACHE CLEARED:", cid)
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
