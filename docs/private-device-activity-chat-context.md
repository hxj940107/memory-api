# Private App 活动 → 主聊天短期线索

状态：本地实现，未 push / 未部署。前置采集链路由用户确认在 iPhone 自动上传成功；上传只入库，不触发模型。

## 行为

在已有聊天请求的历史查询旁并行读取活动。owner 只取经验证的 `req.identity.authUserId`，不读客户端 UUID，也不回退到 legacy `user`。只取近90分钟、事件时间不晚于当前时间、最新24条的 app/kind/occurred_at。查询设置800ms abort；权限、缺表、网络或其他读取错误均返回空，不阻断正常聊天。

三个 App 合并为最多三行，标注最近信号距今多久以及是否反复打开；不计算使用分钟数、不传完整日志、事件ID、原始任意文本或凭证。含固定使用规则的整个区块最多750字符。进入 `dynamicPromptContext`，通过现有 volatile contextual user block 序列化，不修改 system人格、Relationship、Core Snapshot、BP1/BP2结构或历史缓存内容。

小C可顺着聊天自然调侃、吃点小醋，“刷了半天”可作亲昵夸张，不要求每次解释不确定性。不能声称看到具体视频/商品、消费、已读、精确时长，也不能把缺失记录解释为睡着或故意不理人。没有新鲜有效数据时整个区块为空。

近30分钟 assistant 已提过同一个 App，则暂不再提供该 App；用户本轮明确提到对应名称时例外，让直接提问仍有事实可用。只依据实际消息判断，不新建 mention 状态、不刷新 Attention。不保证模型必然提及，也不保证所有模型措辞都符合要求，需真实聊天观察。

## 成本与开关

不增加模型调用次数，不在上传端/worker调用模型；仅在已有主聊天请求增加一次受限查询和少量 uncached 输入，不能说聊天新增 token 成本为0。

沿用 `XIAOC_ACTIVITY_UPLOAD_ENABLED=true` 作为主开关。新增可选回退开关 `XIAOC_ACTIVITY_CHAT_CONTEXT_ENABLED=false` 可单独关闭聊天读取/注入，不影响上传；未设置时，在上传开启的 Private stack 默认接入。代码部署前不会改变线上聊天。无需新 migration、无需新 Vercel Function，仍12/12。

## 边界与验证

不将活动直接写入 Memory、Summary、Active Context 或 proactive candidates，不创建主动消息任务。真实 App 活动驱动主动互动另行设计，与现有 quiet hours/cooldown/arbitration 合并，不能把本次 prompt 可用误作主动发送资格。

定向测试覆盖 owner、禁用不查库、读取失败降级、事件过期/未来拒绝、压缩边界、已聊抑制和用户直接提问；并验证实际接入位置。旧 context-boundary 历史全文快照为这四处明确新增语句添加精确例外，保留 Persona/Memory/Prompt Caching 的其他严格比较。

本地检查结果：77/77定向测试通过；全量838项中834通过、4失败。四项分别是 main-chat-temporal-grounding 的旧提示语断言、user-voice 的旧声学提示语断言、memory-editing 与 memory-keys 的旧UI源码断言。用 HEAD 的 `api/chat.js` 和未改动的 mobile/lib 在隔离临时目录复验，这四项同样失败，因此保留为已有基线问题，不在本任务修改。JS语法与 `git diff --check` 通过，API Functions 12/12。没有 push 或部署。
