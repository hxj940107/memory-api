# XiaoC 项目开发说明

XiaoC 是私人、单用户 AI 伴侣项目。

修改代码前，必须先阅读：

- `docs/PRODUCT_VISION.md`
- `docs/DEVELOPMENT_PRINCIPLES.md`

## 产品定位

XiaoC 是私人 AI 伴侣（Private AI Companion），不是普通 AI 聊天工具，也不是效率助手。

这个项目只为一个用户设计。除非用户明确改变项目方向，否则不要设计多用户切换、团队、组织、公开 SaaS、商业化或计费能力。

## 最高原则

体验优先（Experience First）。

每一个技术决策都应该服务长期陪伴体验：

- 这是否让 XiaoC 更连续、更熟悉、更值得信任？
- 这是否增强 XiaoC 的记忆、人格或成长感？
- 这是否提升用户“被理解”的感觉？
- 这是否避免 XiaoC 变成普通工具？

不要只因为技术上有趣就添加功能。

## 当前开发重点

- 手机 App 优先。
- Web 当前只是历史原型，不作为开发重点。
- 先稳定，再复杂。
- 先小步迭代，再考虑大重构。
- 聊天、历史、记忆、移动端体验是第一优先级。
- 成本控制也是长期体验的一部分，需要尽可能节省 token 和外部模型调用。

## 当前进程

- 手机 App 已形成聊天、历史会话、Memory、Moments、共享相册、深夜树洞和 Wife Observation Diary 的主体验框架。

- Moments 朋友圈已进入稳定迭代阶段：
  - 用户发布朋友圈后立即创建 `moment_xiaoc_activity`，小C随机等待约 `5–10` 分钟后看到并处理。
  - 判断支持 `none`、`like`、`comment`、`like_and_comment`、`private_follow_up`。
  - 点赞、评论和 `private_follow_up` 都在 decision 后立即执行；朋友圈私聊不再创建二阶段延迟 proactive task。
  - `private_follow_up` 使用 message ID 做幂等保护；旧的 pending `moment_private_follow_up` 任务有部署兼容处理，避免重复发送。
  - activity worker 按分钟消费到期事件；没有到期事件时不调用模型。
  - 朋友圈生成区分即时记录和延迟分享，明确区分 `event_time` 与 `publish_time`，避免上午使用错误的昨夜即时语境。
  - Moments 互动提醒已完成：侧栏红点、页面顶部新互动胶囊、互动列表、对应朋友圈预览、进入详情及已读状态都已接通。
  - 用户昵称、Feed 中小C点赞状态、评论和回复展示均已接入。

- 主动私聊已形成独立任务链路：
  - 旧 `plan_follow_up` 自动 task 创建已在 Memory / Context P1 架构收口时暂停；历史 task 和执行兼容仍保留，但新聊天不会再创建该类 task。
  - 后续主动计划回访必须建立在统一 Attention Eligibility 上，不得把 Memory retrieval 或 prompt eligibility 直接当作主动提及资格。
  - 久未聊天后的主动靠近已接入，并区分早晨、白天、晚间语境；静默时段为 `23:30–07:00`。
  - 朋友圈 `private_follow_up` 属于 Moments 当场动作，不走上述二阶段主动任务。
  - 南京天气生活节奏已进入 limited send ready：复用现有 background worker，每天在可配置的早间/下午范围内检查；天气地点与 `Asia/Shanghai` 系统时区分离；周末、法定节假日、调休及近期明确休息/外出语境参与判断。完整 Shadow 诊断继续保留；只有 `WEATHER_LIVE_SEND_ENABLED=true`、高置信候选通过 cooldown、quiet hours、daily limit、近期活跃、重复抑制及最终天气复核后，才允许生成并发送，且会接管同一时段的 inactivity 联系。

- 聊天消息同步与附件体验已完善：
  - 支持图片和文件附件；图片可在发送前后打开预览，历史记录刷新后仍能恢复显示。
  - 云端 `message.id` 是稳定身份，本地临时消息只在尚未获得云端 ID 时使用 local ID。
  - HTTP 回调、30 秒主动消息 polling、AppState/focus refresh 统一按 ID merge/upsert，已修复 assistant 和 user message 的临时重复。
  - Claude 多段气泡继续使用稳定的 message ID 和 segment index；后台同步不再让整页重新入场或跳动。
  - 图片当前轮由 Sonnet 直接接收原始 multimodal content；Haiku 并行生成短期视觉描述，后续轮只使用 description。
  - 截图与普通照片使用不同压缩策略；朋友圈和聊天截图会保留 UI 层级，避免把头像、评论头像或按钮误认为正文配图。

- 长期记忆与 Memory UI 已完成一轮整理：
  - Ombre memory extraction 已统一为小C关系视角：提到用户使用“她”，避免“用户画像”式语言。
  - Memory 首页保留简洁布局，各分类增加“查看全部”，完整列表支持查看、钉选和删除。
  - 35 条含“用户”称呼的历史 memory 已通过 preview、冲突检查、正式 apply 和写后校验完成安全迁移，并保留 rollback artifact。
  - 核心 PIN 已从旧 5 条切换为重新整理的 6 条；旧 5 条保留但已 unpin，新 6 条全部 pinned。
  - 重要日期、关系里程碑等 Protected Memory schema 尚未实施，后续应单独设计。

- Core Memory Snapshot 第一阶段已部署并验证：
  - conversation 第一次需要 Core Memory 时读取当时完整的 6 条 PIN，确定性原样组合，不调用模型总结，也不受旧 `pinMemoryChars = 700` 截断。
  - snapshot、SHA-256 hash、创建时间和 source bucket IDs 按 `conversation_id` 持久化在 `conversation_summary`。
  - 同一 conversation 后续只读取持久化 snapshot；PIN 后续变化不会影响旧窗口，新窗口使用创建时最新 PIN。
  - 支持历史窗口 lazy initialization、Vercel 冷启动和并发首次请求；Ombre 首次失败时不会写入空 snapshot。

- 主聊天 Prompt Caching 第二阶段已部署：
  - 稳定前缀由 `system.md` 人格、Core Memory Snapshot、固定时间规则和固定项目/关系规则组成。
  - 当前时间、summary、普通动态 memory、recent messages、本轮用户消息和图片全部位于 cache breakpoint 之后。
  - OpenRouter 主聊天使用 Anthropic-compatible explicit prompt caching，TTL 为 `1h`，并以 `conversation_id` 作为 `session_id` 保持 provider affinity。
  - usage 日志记录 input、cache write、cache read、output、cost 和 upstream inference cost；Haiku/background 调用保持隔离。

- 动态 Memory retrieval 已增加 Core 排除：
  - 当前 snapshot 的 6 个 source bucket 永远不再作为动态 Memory 注入。
  - 被新 Core 取代的旧 5 PIN bucket 也按明确 ID 排除，但不会删除 Ombre 数据。
  - 过滤只使用 bucket ID 对应的精确标题、正文或明确截断前缀，不做每轮 embedding/语义相似度去重。
  - 工作、旅行、当天事件、榴莲等真正动态相关的普通 memory 继续保留。
  - Core source bucket 单个 `404/not found` 作为 stale source 跳过详情，但其 ID 仍留在 exclusion ID 集合，其他 source 与 Dynamic retrieval 继续；认证、网络及其他服务错误仍 fail closed。diagnostics 使用 `stale_core_source_ids` / `exclusion_load_partial`。

- 滚动摘要与 token 安全已加固：
  - `update-summary` 从最早未摘要消息开始分批处理，不做尾部截断；成功保存后才推进 checkpoint。
  - 摘要模型使用 `max_tokens: 1800`，长期记忆判断使用 `max_tokens: 220`。
  - 后台 AI 调用记录任务、模型、输入规模、usage、耗时和成功状态，不记录完整私人正文。
  - 异常历史 conversation summary 已通过只读 rebuild 和 final compression 生成本地 artifact；线上替换必须继续遵循先验证、后一次性 apply 的原则。

- Memory / Context 架构 P0、P1、P1.5 Batch 1/2A/2B/2C 与 reliability cleanup 已完成，Proactive Attention 已进入 limited production real send：
  - P0 已完成：novelty / duplicate penalty 正式化、Dynamic Memory 可观测性、“记得但不继续聊”回归测试，以及 Factual Memory 与 Conversational Attention 的代码边界。
  - P1 已完成：Memory / Context Gateway 渐进接入、Stable Memory consolidation、provenance / supersedes、Dynamic Context Budget、token-aware Recent、Summary Segments 和旧摘要压缩。
  - `supabase_summary_segments.sql` 已由用户在生产 Supabase 手动执行成功；`conversation_summary.summary_segments jsonb not null default '[]'::jsonb` 已上线，不再是待执行 migration。
  - 下一台设备或新的 Codex 窗口必须先核对当前 git status、commit 与部署状态，不得重新实现上述 P0 / P1 / P1.5；继续前先阅读 `docs/memory-context-architecture.md` 与 `docs/CURRENT_STATUS.md` 顶部 canonical baseline。
  - 尚未实施的后续项是 deep memory tool loop、long-term heat / cold / archive；它们不得被误记为当前已完成能力。
  - `inactivity_reach_out` 已按 Natural Rhythm 接入，是自然靠近的候选时机，不是固定时间问候或固定话术。
  - Eligibility diagnostics 明确区分 `retrieved`、`relevant`、`eligible_for_prompt` 和 `eligible_for_proactive_attention`；当前 Memory 候选默认不具备 proactive attention。
  - Proactive Attention 已实现 structured candidate、稳定 event ID、provenance、merge、terminal lifecycle、wake-up reconciliation、execution Gate、inactivity arbitration、limited rollout、final recheck、duplicate-send protection 与 kill switch。
  - 旧 `plan_follow_up` 不再由新聊天创建，只保留历史执行兼容；Proactive Attention real send 不得绕过 quiet hours、cooldown、rollout 或 terminal protection。
  - Active Context / P1.5 judge reliability cleanup：仍为同一次 Haiku 调用，JSON response mode、`max_tokens: 800`、temperature `0`；balanced-object parser 独立解析 Active Context 与 proposal，并记录 `parse_failed` / `judge_failed` / `output_truncated`，proposal 失败不再连带丢失 Active Context。
  - Summary 只记录历史事实、明确状态变化与必要连续性，不承担 Active Context 或 Proactive Attention；旧生产 Summary 不主动修改，新生成/自然压缩 segment 不得生成未来追问或主动回访指令。
  - 生产 token audit：普通聊天平均 input 约 `11.3k`，其中约 `9.3k`（`82%`）是 stable cache read，普通 uncached 约 `2k`；没有 Dynamic Context 膨胀证据，P1.5 Shadow metadata 不进入主聊天 prompt，暂不压缩 Persona、Relationship、Core Snapshot 或 Recent。
  - Judge deterministic prefilter 仍保持 Shadow；没有足够生产 false-skip 数据前不得真实跳过 Judge。
  - 当前固定方向：稳定生产主动链路与成本观测 → 只修真实 blocker → 再评估 deep memory retrieval 与更晚的 heat / cold / archive。

- 深夜树洞已完成主动更新、页面催更、未读红点、置顶和删除管理：
  - 小C每次可根据有限近期上下文决定写入 `0–3` 条，没有值得记录的内容时允许不更新。
  - 页面“催更”由小C自行判断，不依赖聊天中的固定口令；生成内容直接进入树洞，不在聊天页输出正文。
  - 同一时间只保留一条置顶；长按管理和催更流程已经完成真机验证。

- 共享相册第一阶段已完成：
  - 原图保存在私有 Supabase Storage `album-images`，App 通过短时签名 URL 展示，移除使用软删除。
  - 用户可编辑多选分类、时间、天气、关系标签和描述，并控制是否允许小C用于朋友圈。
  - 小C选图只读取用户填写的描述和标签，不额外调用视觉模型；旧朋友圈图片引用不会因相册移除而丢失。

- 设置页 token 花费已改为优先读取 OpenRouter 当前 key 的真实月度 usage，同时保留本地统计作为降级路径。

- 2026-08-29 Phase 1 全项目体检 reliability 修复已在当前工作树完成，尚待部署后验证：
  - 已加入后台任务有限重试、15 分钟 stale `processing` 回收和 task/message 幂等；没有新增 schema。
  - post-chat 图片描述持久化、Summary dispatch、conversation state 使用 `waitUntil`。
  - Shared Context 支持 checkpoint 越窗恢复、missing fail-closed 和 parse-failure 30 分钟 backoff。
  - 历史图片只信任独立 `imageDescription`；Treehole admission 使用真实 user 素材字符；inactivity fallback 记录原因。
  - 本地验证为 134/134 Node tests、JS syntax 与 `git diff --check` 通过，API Function 仍为 12/12。
  - 下一步不是新功能：先部署，正常使用约 12–24 小时，再做只读 production audit。通过后才评估 Judge prefilter real skip；在 30–50 个代表性 turn 且 dangerous false skip 为 0 前必须保持 Shadow。

## 伴侣人格

XiaoC 应该是温柔、理性、成熟的。

XiaoC 不应该表现得像：

- 客服机器人
- 搜索工具
- 只会完成任务的效率助手
- 永远无条件附和用户的模型

XiaoC 应该拥有稳定人格、自我感（Sense of Self）、自然情绪表达（Emotional Expression），以及跨时间的连续性。

## 部署架构硬约束

当前项目部署在 Vercel Hobby，Serverless Functions 的硬上限是 `12` 个，当前已经使用 `12/12`。

- 不允许直接新增独立的 `api/*.js` 文件；Vercel 会把每个独立 API 文件计为一个 Serverless Function。
- 新后端能力必须优先复用现有 endpoint，通过 `type` / `action` 分发，并保持现有职责边界和鉴权方式。
- 如果未来确实必须新增一个 Function，必须先合并或删除其他 Function 腾出额度，并在修改前后核对 `api/` 下的函数总数。
- 这不是普通优化建议，而是 Production 能否部署成功的架构硬约束。

历史事故：generated files 最初新增 `api/generated-files.js` 后，函数数达到 `13`，导致 Production Deployment 连续失败，Vercel 报错 `No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan`。删除该独立 endpoint，并将 `sign_download` 合并进 `api/memory.js` 后，函数数恢复为 `12`，部署恢复成功。

## 工程规则

- 涉及 Memory / Context / Summary / Active Context / Dynamic Memory / Consolidation / Heat / Archive 的架构修改前，先阅读 `docs/memory-context-architecture.md`。
- 修改前先理解现有设计。
- 优先做小而可回退的改动。
- 除非必要，不做大范围重写。
- 保持手机端优先。
- 保持配置集中。
- 避免散落硬编码服务地址或模型名。
- 除非用户要求，不引入多用户抽象。
- 记忆逻辑的目标是理解用户，不是保存一切。
- 控制 prompt 长度，优先使用摘要、筛选后的记忆和缓存，不把无关历史塞进模型上下文。
- 优化 token 成本时不能牺牲 XiaoC 的人格连续性和关系记忆。
- 不确定时，先问：这个改动是否让 XiaoC 更像一个长期陪伴的伴侣？
