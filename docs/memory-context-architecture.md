# XiaoC Memory & Context Architecture

本文档记录 XiaoC 的 Memory / Context 架构边界、已经验证的设计约束，以及从 Sora-mem 代码级研究中提炼出的长期演进方向。它不是功能清单，也不表示下文的 Future 机制已经实施。

## 0. 当前交接状态

截至本轮交接，Memory / Context P0、P1、P1.5 Batch 1 与本轮 P1 / P1.5 reliability cleanup 均已完成；cleanup 已提交并推送为 `d955608`，当前 `main` 与 `origin/main` 同步。下一台设备或新的 Codex 窗口应先确认生产部署状态，再从该 commit 继续，不要重新实现本节列出的能力。

### 0.1 已完成

P0 已全部完成：

- novelty / duplicate penalty 已形成统一、确定性的 context eligibility；
- Dynamic / Stable Memory 候选具备必要的 eligibility observability；
- “长期记得，但当前不应继续聊”已经有定向回归测试；
- Factual Memory 与 Conversational Attention 保持代码级分离，Memory retrieval / injection 与 assistant 自己提及均不能刷新 Active Context attention。

P1 当前已完成：

- Memory / Context Gateway 已渐进接入，集中处理 Stable / Dynamic Memory eligibility、跨层 suppression、共享预算和诊断；
- Stable Memory consolidation 已实现确定性 cluster 前置筛选、按需 small model 判断、源 episodic 保留，以及 conflict skip；
- provenance / supersedes 已通过现有 `memories.metadata` 承载，旧 Stable 不硬删除，retrieval 默认优先未被 supersede 的新 Stable；
- Dynamic Context Budget 已实现 Recent、Active、Summary、Memory、Temporal Ledger 和 Web context 的确定性场景分配；
- Recent History 已改为 token / character budget 与 hard message / turn 上限共同控制，并优先保留最新完整 turn；
- Conversation Summary 已改为可追踪的 Summary Segments，记录 covered message IDs，并支持旧 segments 超预算后的二次压缩；
- `supabase_summary_segments.sql` 已由用户在生产 Supabase 手动执行成功；生产环境已存在 `conversation_summary.summary_segments jsonb not null default '[]'::jsonb`，不再有待执行 migration。
- 旧 `plan_follow_up` 自动 task 创建已暂停；Active Conversation Context 更新与 `inactivity_reach_out` 保持，历史 task 及执行兼容不删除。
- Memory eligibility diagnostics 已显式区分 `retrieved`、`relevant`、`eligible_for_prompt` 与 `eligible_for_proactive_attention`。当前 Memory 检索或 prompt 注入不会自动获得 proactive attention。
- P1.5 Batch 1 Proactive Attention Shadow Mode 已完成：structured event candidate、代码生成且稳定的 `event_id`、真实 user message source provenance、同事件 merge、terminal lifecycle（completed / cancelled 不自动 reopen）均已实现。
- deterministic Shadow Gate 已实现，并显式输出 `eligible_for_proactive_attention`、reason、confidence 与 hard rejection diagnostics。
- 当前仍是严格 Shadow Mode：candidate snapshot、merge 与 Gate diagnostics 只写 assistant message metadata；不创建 `proactive_attention` task，不发送 event follow-up，不阻塞或改变 `inactivity_reach_out`，不恢复旧 `plan_follow_up` 自动创建，也不改变 cooldown、quiet hours 或 daily limit。
- P1.5 Batch 2 candidate → scheduler wake-up 尚未实施。

本轮 reliability cleanup 已完成、通过测试并 commit/push；下一步是确认或完成生产部署：

- Active Context / P1.5 judge 仍只使用原有一次 Haiku 调用，没有增加每轮 LLM 调用次数；调用改为 JSON response mode，`max_tokens` 从 `520` 调整为 `800`，temperature 为 `0`。
- judge output 改用 string-aware balanced-object parser，并对 Active Context 与 proactive event proposal 独立提取和验证。proposal 失败不再连带丢失已经完整的 Active Context，也不会伪装成正常 `action=none`。
- Shadow metadata 新增 `parse_failed`、`judge_failed`、`output_truncated`、分区 error code、finish reason 与有限 `raw_output_summary` diagnostics；非法 action/state/window 等语义字段仍拒绝，不使用无限宽松 parser。
- Dynamic Memory Core exclusion 允许单个 source bucket `404/not found` 作为 stale source 跳过详情读取；stale ID 仍保留在 exclusion ID 集合中，其他 source 正常加载，partial exclusion 后 Dynamic Memory retrieval 继续。
- exclusion diagnostics 包含 `stale_core_source_ids` 与 `exclusion_load_partial`。认证、网络、非 404 服务错误和异常空正文仍 fail closed；不修改或重建已有 Core Snapshot。
- Summary segment prompt 已收口为只记录历史事实、明确状态变化和必要连续性，不承担 Active Context 或 Proactive Attention，不再生成未来提问、追踪、提醒或主动回访安排。旧生产 Summary 不主动改写；新生成或自然压缩的 segment 使用新规则。

生产 token audit 结论：

- 最近普通聊天平均 input 约 `11.3k` tokens，其中 cache read 约 `9.3k`（约 `82%`），普通 uncached input 约 `2k`，output 很小。
- stable prefix（Persona、Relationship Contract、Core Snapshot、fixed rules）是主要名义 token 来源且稳定命中 prompt cache；当前没有证据表明 Dynamic Context 膨胀。
- P1.5 `proactiveAttentionCandidates`、`proactiveAttentionDiagnostics` 与 `proactiveAttentionShadow` 不进入主聊天 prompt；Recent 最终也只发送真实 `role/content`，不发送 assistant metadata。
- 暂时不要为了名义 input 数字压缩 Persona、Relationship Contract、Core Snapshot 或 Recent。后续可单独完善 generation ID 与 cache read/write 的 usage observability，但它不是当前 blocker。

### 0.2 待继续

以下项目尚未实施，不得与上述已完成状态混淆：

- P1.5 Batch 2 candidate → scheduler wake-up；
- execution-time Attention Gate 与 inactivity arbitration；
- long-term Memory heat；
- cold / archive lifecycle；
- deep memory on-demand tool loop。

旧 Shadow production 的 `0 candidate` 样本包含 judge parser failure，不能用于判断 candidate recall。reliability cleanup 部署后必须重新积累可信样本；进入 Batch 2 前至少希望看到：

- `2–3` 个真实 candidate；
- 至少一个现实事件多次更新仍保持同一 `event_id`；
- 至少一个 completed 或 cancelled lifecycle；
- 至少一个有用户证据的合理 `expected_window`；
- 至少一个 Gate rejection / hard rejection；
- `proactiveAttentionShadow.judge.status` 基本稳定为 `parsed`。

Artifact、周/月回顾和共读仍属于 P2 产品扩展，也尚未实施。本轮没有改变 Persona、Relationship Contract、Core Memory Snapshot、PIN、Dynamic Context Budget、Recent budget、proactive scheduler、Moment、Diary、generated files 或模型选择。

### 0.3 继续开发约束

- 当前 `api/*.js` 必须继续保持 12 个，不得新增 Vercel Function；
- reliability cleanup 已位于 `d955608`；换设备后先核对生产部署状态，禁止重新施工 P0、P1、P1.5 Batch 1 或本轮 cleanup；
- `supabase_summary_segments.sql` 只作为已执行的 schema 记录保留，不得再把它报告为待执行 migration。
- 重建主动计划回访前，必须先建立独立 Attention Eligibility；不得恢复按单条 message 自动创建 `plan_follow_up` 的旧路径。
- Shadow Mode 观测稳定前，不得把 `eligible_for_proactive_attention=true` 接入 scheduler 或发送链路；Memory / Summary / Core / retrieval 只能提供事实，不能创建或刷新 proactive event candidate。
- 当前顺序固定为：部署 reliability cleanup → 重新积累真实 Shadow production 样本 → 只读审计 candidate / merge / state / expected window / Gate → Shadow 验证通过 → P1.5 Batch 2 candidate → scheduler wake-up → execution-time Attention Gate / inactivity arbitration → on-demand deep memory retrieval → 更晚再考虑 heat / cold / archive。

## 1. 当前核心设计原则

### 1.1 Memory existence ≠ reason to mention it

一条 Memory 存在、被检索到或被注入上下文，只说明 XiaoC 可以知道这件事，不代表当前回复应该主动提起它。Memory 是背景事实，不是话题推荐器。

### 1.2 Factual Memory ≠ Conversational Attention

- Factual Memory 回答“这件事是否发生过、她有什么长期偏好、我们形成过什么稳定认识”。
- Conversational Attention 回答“这件事现在是否仍未完成、仍在等待、仍值得自然接着聊”。

两者必须独立建模。长期事实可以长期存在，但当前注意力必须能在没有新证据时自然衰减。

### 1.3 当前信息优先级

- Recent Messages 是当前对话事实和说话人归属的最高优先级来源。
- current user message 是判断本轮意图、状态和注意力的直接证据。
- Active Conversation Context 负责当前未完成、等待、计划和持续事项。
- Conversation Summary 负责 recent raw window 之前的历史连续性，不是当前注意力列表。
- Stable Memory 和 Dynamic Memory 负责 XiaoC“知道什么”，不负责决定“现在聊什么”。
- Core Memory / PIN 负责稳定核心认识与关系连续性，不是当前话题推荐器。

当不同层发生冲突时，当前用户原话和真实 Recent Messages 优先于旧 Summary、旧 Memory，以及 assistant 对自己历史行为的临时陈述。

## 2. XiaoC 当前架构

### 2.1 Persona

`system.md` 定义 XiaoC 的稳定人格、表达边界和陪伴方式。

它应承担“XiaoC 是谁、如何自然表达”，不应存放用户近期事件、当前任务或会话流水。

### 2.2 Relationship Contract

Relationship Contract 定义关系定位、长期互动边界和稳定的关系规则。

它不应随着普通生活事实频繁变化，也不应承担动态记忆检索或当前话题选择。

### 2.3 Core Memory Snapshot

Core Memory Snapshot 在 conversation 第一次需要 Core Memory 时，确定性读取当时的 PIN，并按 `conversation_id` 持久化 snapshot、hash、创建时间和 source bucket IDs。同一 conversation 后续继续使用该 snapshot，新 conversation 才读取最新 PIN。

它负责稳定身份认识和关系连续性；不应因普通语义相关性每轮变化，也不应因为某条 Core Memory 被注入就主动带回旧话题。

### 2.4 Recent raw messages

Recent raw messages 保留真实 `role/content`。当前实现先预取 41 条，再由 token / character budget、最多 32 条消息与最多 16 个完整 turn 共同选择，并配合独立的 Recent Message Ledger 提供时间与来源元数据。

Recent 是当前对话最直接的连续性证据。时间戳、主动消息来源等元数据必须放在独立 ledger 中，不能改写进 assistant history content，否则会污染说话内容、时间语境和模型对历史原话的判断。

### 2.5 Temporal / Proactive Ledger

Temporal / Proactive Ledger 提供消息发生时间、来源和主动行为类型，用于区分真实时间、事件时间与聊天行为时间。

它只提供元数据和事实 grounding，不应改变历史消息正文，也不应把过去事件自动解释为当前状态。

### 2.6 Active Conversation Context

Active Conversation Context 保存有限数量的当前有效事项，类型包括：

- `transient`
- `plan`
- `waiting`
- `unresolved`

它通过 `source_message_id`、`last_referenced_message_id` 和 `missed_turns` 管理当前注意力。`transient` 事项在连续未被当前用户消息明确引用后退出；计划、等待和未解决事项按各自语义继续保留。

Active Context 不是 checklist，也不能因为一项仍存在就要求 XiaoC 在每轮主动提起。

### 2.7 Stable Memory

Stable Memory 保存明确、稳定、长期有价值的用户事实与关系认识。

它应提供可靠背景，不应保存所有短期 observation，也不应替代 Active Context 表示当前关注。

### 2.8 Dynamic Ombre Memory

Dynamic Memory 根据当前消息和近期用户消息做语义检索。当前链路会：

- 排除 Core Snapshot 的 source buckets；
- 排除被新 Core 取代的旧 PIN buckets；
- 对 Dynamic Memory 内部去重；
- 抑制已经存在于 Recent 或 Active Context 的内容；
- 当用户当前消息明确重新提及时允许相关内容通过；
- snapshot source bucket ID 始终直接进入 exclusion ID 集合；单个 source `404/not found` 只记录 stale diagnostics 并跳过该详情，其他 source 继续加载，Dynamic retrieval 继续；认证、网络或其他服务错误仍 fail closed。

Dynamic Memory 只应在当前消息自然需要时作为背景使用。语义命中不等于当前话题仍活跃。

### 2.9 Conversation Summary

Conversation Summary 从最早未摘要消息开始按顺序滚动处理，并在成功保存后推进 checkpoint。注入前还会抑制与 Recent Messages 重叠的摘要内容。

Summary 负责 recent raw window 之外的连续性，不应重复放大 Recent、Active 或 Dynamic Memory 已经提供的事实，也不应成为当前注意力列表。

### 2.10 Current user message

当前用户消息是本轮意图和 attention refresh 的最高优先级证据。只有用户当前重新提及、确认、更新或自然延续某件事时，旧事实才应重新获得当前注意力。

## 3. 最近已经解决的问题

以下问题已经通过当前架构处理。后续修改不得无意重新引入。

### 3.1 Timestamp 污染 assistant history

时间戳、主动来源和其他元数据不能拼进 assistant 历史正文。它们应位于独立 ledger；Recent Messages 必须保持真实 `role/content`。

### 3.2 Recent / Active / Summary / Dynamic Memory 重复加权

同一个普通生活事实曾可能同时出现在多个上下文层，导致模型把“多层重复出现”误解为“当前仍然非常重要”。当前通过以下边界降低重复权重：

- Active Context 不重复 Recent 中仍可见的 source message；
- Summary 注入前抑制与 Recent 重叠的内容；
- Stable / Dynamic Memory 抑制与 Core、Recent、Active 重叠的内容；
- 当前用户明确重新提及时，允许相关背景重新出现。

### 3.3 Transient Active Context attention decay

`transient` 事项通过 `missed_turns` 衰减。只有当前消息明确引用时才刷新；仅仅保留在旧 context、被模型看到或被 assistant 自己再次说出，不能刷新用户 attention。

### 3.4 Dynamic Memory recency suppression

近期原话已经足够提供事实时，不应再把同一内容作为 Dynamic Memory 注入。这样可以避免“记得”被模型误解成“现在仍应继续聊”。

### 3.5 Assistant 临时自述不能固化为事实

assistant 在主动消息、总结或普通回复中对自己更早行为的叙述，不能自动成为历史事实。真实消息账本、用户原话和用户明确确认的事实优先。没有可靠证据的“小C以前说过/做过”不应进入 Active Context 或长期 Memory。

## 4. 从 Sora-mem 值得借鉴的机制

本节基于对 Sora-mem commit `ab8e9a374a8581fe1d08390e3bef950bb5d5ef89` 的实际源码审阅。这里记录可借鉴的机制边界，不表示 XiaoC 应复制其基础设施或公式。

### 4.1 Memory lifecycle

Sora-mem 的 Memory 数据模型显式保存：

- `heat`
- `locked`
- `archived / archived_at / archive_reason`
- `activation_count / last_active`
- `source / source_id / source_conversation_id`
- `category / tags`
- emotion 相关字段

它还通过 `memory_sources` 保存对话来源、message IDs、quote、前后文、conversation summary，以及 consolidation 后的来源继承关系。

值得借鉴的是：

- Memory 不应永远处于单一、等权状态；
- Memory 应有可解释 lifecycle；
- stable 结论应能回溯 source provenance；
- cold/archive 应成为检索访问策略，而不只是 UI 分类。

必须注意：Sora-mem 的 heat 表示近期写入、检索和系统访问形成的可访问性，不等同于 conversational attention。

### 4.2 Consolidation

Sora-mem 的自动 consolidation 是写入后触发的维护流程：

1. 在 daily 或单个 project scope 中排除 locked 和已 consolidated memory；
2. 少于 15 条时不运行；
3. 取最旧的 15 条作为候选窗口；
4. 使用 embedding 相似度，从 15 条中选择语义密度较高的 10 条组合；
5. 调用 LLM 生成 1–4 条 consolidated memory，并要求每个 source index 被使用或明确丢弃；
6. 新 memory 继承 source provenance；
7. 自动流程成功后删除原 memory 行。

它会要求较新的完成、取消、改变方向等状态覆盖旧计划，并对无效 JSON 做一次 LLM 修复重试。该流程因此会增加 consolidation LLM 和 embedding 成本。

XiaoC 的长期推荐方向是：

```text
episodic observations
  → semantic/identity cluster
  → stable memory proposal
  → provenance + source IDs
  → accept/update/supersede
```

与 Sora-mem 不同，XiaoC 应：

- 保留原始 observation 或至少保留完整、可恢复的 source record；
- 先生成 stable proposal，不立即把 LLM 输出视为最终事实；
- 显式记录 `supersedes`，不要只依赖 prompt 中“新状态覆盖旧状态”；
- 不自动修改 PIN 或 conversation-scoped Core Memory Snapshot。

### 4.3 Adaptive Context Compression

Sora-mem 的会话内压缩按模型 token window 比例工作：

- 触发线和硬上限由模型窗口、buffer、margin 计算；
- recent verbatim 区域约占窗口的 20%，不是固定 recent N；
- 旧消息压缩为持久化的 `summary` message；
- summary metadata 保存 `segment` 和 `covered_ids`；
- 原消息不删除；prompt 构建时通过 `covered_ids` 避免 summary 与原文同时进入；
- summary 总量超预算或 segment 过多时，将最旧两段继续合并；
- 编辑原消息时，可通过 `covered_ids` 作废相关 summary，让原文重新进入后续压缩流程。

这是一种按模型窗口比例自适应的压缩，不是按当前任务、topic 或 conversational attention 自适应。它没有实现统一的 salience classifier，也没有按陪伴、创作、工具任务动态分配各层预算。

XiaoC 长期可借鉴：

- token-aware recent window；
- segment summary；
- covered message IDs；
- 保留可重新访问的原始消息；
- old summaries progressively compressed，让较老历史更模糊、较近历史更完整。

### 4.4 Memory Gateway / Tool Retrieval

Sora-mem 的 `memory_gateway.py` 实际承担：

- vector + keyword hybrid search；
- ranking 和结果格式化；
- memory write/update；
- duplicate detection 与 LLM merge；
- memory source capture、inherit 和 recall；
- conversation summary 读写的一部分。

它没有统一承担：

- 全局 token budgeting；
- Recent / Summary / Active / Memory 跨层去重；
- archive access policy；
- consolidation 执行；
- 完整 prompt assembly。

Sora-mem 的 passive retrieval 与 tool retrieval 仍然分裂：被动注入直接调用旧检索 helper；Gateway 的 prefetch mode 当前被禁用；主模型的 `search_memory` tool 则走 Gateway hybrid retrieval。两条路径的 ranking 和 heat touch 行为不同。

On-demand memory tool 的收益是：

- 深层 Memory 不必每轮注入；
- 主模型可以根据问题生成更聚焦的 query；
- 可通过二阶段 source recall 获取原文证据。

成本和风险是：

- 每轮 tool call 增加主模型请求、延迟和输入 token；
- 搜索通常还需要 query embedding；
- 模型可能机械检索、重复检索或把检索命中误当当前注意力；
- tool 结果仍需跨层 duplicate suppression。

XiaoC 长期可考虑的混合结构是：

```text
Core always injected
+ 极少 high-confidence memory prefetch
+ deep memory on-demand tool
+ source evidence on-demand
```

当前不实施该结构。

## 5. 明确不应照搬的 Sora 机制

- Passive injection 不应提升“用户兴趣 heat”。系统把一条 Memory 放进 prompt，不等于用户重新关注它。
- Assistant 自己搜索到或主动提起一条 Memory，不应让它显著升温。
- Heat 不应直接控制 conversational attention。
- Sora-mem 的 archive 状态没有从普通向量、关键词和被动 retrieval 中排除；这种“归档后仍正常召回”不值得复制。
- Consolidation 后直接删除唯一原始 Memory 行不适合 XiaoC。必须保留 rollback-safe provenance。
- Consolidation 不得自动修改 PIN 或 Core Memory Snapshot。
- Sora-mem live streaming chat 的共享工具循环上限为 16 轮，不适合日常陪伴聊天的延迟和成本目标。
- 不迁移 FastAPI、PostgreSQL/pgvector、VPS 或 Capacitor。
- 不以 Sora-mem 的多项目、多来源组织方式为理由引入 XiaoC 不需要的多用户、SaaS 或基础设施抽象。

## 6. Future Memory Heat 原则

如果未来 XiaoC 增加 heat，必须先区分“用户重新激活”与“系统内部访问”。

### 6.1 强升温来源

- 用户明确重新提及某个已知事实；
- 用户重新确认该事实仍然成立；
- 用户提供了对旧事实的更新、修正或状态变化；
- 临近一个已经确认的未来事件，且时间 grounding 表明它即将发生。

### 6.2 不升温或只允许极弱系统信号

- passive prompt injection；
- assistant 自己主动提起；
-模型主动执行 memory search；
-系统因相同 query、cache miss 或后台任务重复检索；
-同一轮在多个 context 层重复出现。

### 6.3 不同维度必须保持独立语义

- `importance`：长期价值和保护程度。
- `heat`：最近是否被用户重新确认或激活。
- `attention`：当前 conversation 是否仍应自然围绕它继续。
- `semantic relevance`：它与当前 query 的语义匹配程度。
- `novelty`：它是否提供当前上下文中尚未出现的新信息。

这些维度可以共同影响 eligibility 或 ranking，但不能混成一个无法解释的“重要分”。尤其不能用 long-term heat 代替 Active Context attention decay。

## 7. Future Consolidation 方向

目标架构：

```text
episodic
  → cluster
  → stable proposal
  → provenance / source IDs
  → supersedes
  → rollback-safe apply
```

设计边界：

- cluster 应基于事实 identity、语义相关性和 scope，不把仅仅同时发生的生活片段强行合并；
- proposal 必须能解释由哪些 observations 支撑；
- conflicting facts 应生成显式更新关系，而不是静默覆盖；
- stable apply 前后都应可校验和恢复；
- 原 observation 不应因为 proposal 成功就失去可追溯性；
- PIN/Core 始终需要单独的人为确认或明确、保守的规则确认；
- consolidation 的 token、embedding 和 LLM 成本必须单独记录。

## 8. Future Context Orchestrator

长期理想结构：

```text
Recent
Active Attention
Summary
Selected Memory
        ↓
Context Orchestrator
        ↓
Main Chat Prompt
```

统一 Context Orchestrator 应逐步承担：

- `eligibility`：某个来源本轮是否允许进入；
- `duplicate suppression`：跨 Recent、Active、Summary、Core、Stable、Dynamic 去重；
- `novelty`：候选是否补充了新事实；
- `token budget`：在总动态预算内分配各层空间；
- `source priority`：当前原话、真实消息、稳定事实和模型生成摘要的可信顺序；
- `observability`：记录候选为何入选、被哪层抑制、是否由用户当前重提而豁免。

演进必须渐进完成。当前不要一次性大重构 `api/chat.js`，也不要为了建立 Gateway 新增独立 `api/*.js` endpoint。Vercel Hobby 仍受 `12/12` Serverless Functions 硬约束。

## 9. 优先级

### P0：已完成，继续保持和验证

- 保持 factual memory / conversational attention 分离；
- 保持并提高 context duplicate / novelty 的可观测性；
- 为“记得，但现在不应继续聊”建立回归测试；
- 防止 timestamp 污染、assistant 临时自述固化和跨层重复加权回归。

### P1：已完成部分

- stable memory consolidation；
- provenance / source IDs / supersedes；
- gradual Memory / Context Gateway；
- token-aware recent；
- segment summary、covered message IDs 与旧摘要压缩；
- dynamic context budget。

### P1.5：当前 Shadow 验证顺序

- 部署已完成的 reliability cleanup；
- 重新积累并只读审计真实 Shadow candidate lifecycle 与 Gate diagnostics；
- 验证通过后再实施 Batch 2 candidate → scheduler wake-up；
- scheduler 执行前必须再次运行 execution-time Attention Gate，并与 inactivity 做明确 arbitration，不得互相阻塞或重复发送。

### P1：更后续

- on-demand deep memory retrieval / memory tool loop；
- long-term heat / cold / archive；这些能力必须晚于 P1.5 Shadow 与 scheduler 边界验证，且 deep retrieval 仍只能提供事实证据，不能授予 proactive attention。

### P2：未来产品扩展

- Artifact：持续可编辑、版本化对象，与一次性交付 Attachment 分离；
- 周/月关系回顾，不替换现有 Wife Observation Diary；
- 共读模式中阅读进度与长期观点分离。

### Not recommended

- 用 passive injection 或模型搜索制造用户 heat；
- 用 heat 替代 Active Context attention；
- archive 后仍默认参与普通 retrieval；
- consolidation 后不可恢复地删除唯一来源；
- consolidation 自动更新 PIN/Core；
- 在日常聊天中采用高轮数 tool loop；
- 一次性重构主聊天 context assembly；
- 因参考项目而迁移 XiaoC 技术栈或新增 Vercel Function。

## 10. 外部参考

- 参考仓库：[Sora-mem](https://github.com/Jade3551/Sora-mem)
- 审阅 commit：[`ab8e9a374a8581fe1d08390e3bef950bb5d5ef89`](https://github.com/Jade3551/Sora-mem/tree/ab8e9a374a8581fe1d08390e3bef950bb5d5ef89)

Sora-mem 是本设计文档的外部参考实现，不是 XiaoC 的运行依赖，不是技术栈迁移目标，也不是判断 XiaoC 架构优劣的默认标准。借鉴范围仅限生命周期、数据模型、ranking、context orchestration 和 module boundaries。
