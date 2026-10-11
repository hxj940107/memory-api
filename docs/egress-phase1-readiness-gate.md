# XiaoC Egress Phase 1 — Deployment Readiness Gate

验收日期：2026-10-08（Asia/Shanghai）。结论：**NO-GO**。

本轮仅本地整合、离线测试与生产部署元数据只读核对；没有 push、部署、OTA、数据库写入、Schema/RLS/Auth/Cron/环境变量修改。本文中的发布和回滚命令是操作方案，未执行，执行需要另行批准。

## 1. 集成基线与提交

- 当前生产：`dpl_E4SS4KU5GsvkyoDYP3Af437dftp1`，`READY`，commit `25ee64531cfc2fe731424cd8d2b1a1488132afce`。
- 集成分支：`codex/egress-phase1-readiness`，直接从上述生产 commit 创建。
- 原 `main` 保留在 `3334e80`，没有覆盖旧分支或用户未提交文件。
- 六个 cherry-pick 无冲突：

| 原提交 | 集成提交 | 内容 |
| --- | --- | --- |
| d78a128 | 9ad739f | 轻量历史与前台 polling |
| 045f447 | 4747ddd | embedding 元信息读取 |
| 6e135d5 | d98e996 | inactivity 分阶段读取 |
| c174d64 | 7178012 | 主动候选投影 |
| 91ee3bb | 130f4e8 | 素材投影 |
| 3334e80 | 74d0fdb | 同步回归 |

集成补充 `413416e`：新手机遇到旧后端明确返回 HTTP 400 / `unsupported history action` 时，降级到原 `list` / `limit:1`。无新 timer，按读取时钟缓存不支持状态 60 秒；之后重试轻量接口。401/403、其他 400、5xx、timeout 均不降级。这让后端紧急回滚后仍能同步消息，但降级期间重新产生旧查询的大字段流量。

以下生产 Memory capture 文件与生产基线逐字相同：`api/chat.js`、`lib/aiConfig.js`、`lib/memoryJudge.js`、`lib/xiaocMemoryNativeCapture.js`、`lib/xiaocMemoryObservationAudit.js`、`supabase_xiaoc_memory_capture_question_contract.sql`、`supabase_xiaoc_memory_engine_foundation.sql`，以及 `tests/xiaoc-memory-capture-v2.test.js`。没有用旧本地源码替换生产 capture 更新。

语义复核：list/search/context 保留；history latest 使用原 owner、conversation 和 created_at/id 排序；主动候选恢复保留八天/120 条和最新有效快照语义；素材消费结果离线对比一致；embedding staleness/repair/retrieval 未改。Inactivity 恢复增加 anchor 重查与最多一次立即重试，持续竞争时 fail closed 留待正常下一轮，没有修改 scheduler 频率。

## 2. 测试证据

| 验证 | 结果 |
| --- | --- |
| 未修改生产基线全套，当前工作目录素材 | 674/678，通过；4 项失败 |
| 最终集成全套 | 710/714，通过；相同 4 项失败；新增失败 0 |
| 关键 capture、检索、embedding、主动陪伴、素材、history、身份测试集合 | 249/249 |
| 移动 TypeScript | 通过 |
| 修改的后端 JS syntax、git diff --check | 通过 |
| Serverless Functions | 12/12 |

日志为临时本地诊断文件 `/tmp/xiaoc-readiness-production-baseline.log`、`/tmp/xiaoc-readiness-final.log`、`/tmp/xiaoc-readiness-critical.log`、`/tmp/xiaoc-readiness-ts-final.log`；不是生产日志，不包含生产聊天或图片。

四项失败在未修改的 `25ee645` 已存在，未为本次验收修改它们：

1. `tests/main-chat-temporal-grounding.test.js:27`：main-chat 测试中的旧 prompt 字面断言 `/过去事件语境不能自动变成当前行为状态/` 不匹配；本次未改 `api/chat.js`。
2. `tests/memory-editing.test.js:15`：源码断言 `/setContent\(nextContent\)/` 不匹配；本次未改 Memory detail UI。
3. `tests/memory-keys.test.js:10`：源码断言 `/new Set\(/` 不匹配；本次未改 Memory overview/category/detail UI。
4. `tests/user-voice.test.js:12`：旧 prompt 字面断言 `/不得声称听出了她的音色、语速、停顿、笑声、哭腔、疲惫、撒娇/` 不匹配；本次未改 `api/chat.js`。

以上证明与本次新增修改无关，不证明这些原有检查可以永久忽略；应单独处理，不能为了绿灯修改人格或删除断言。

`latest` 离线覆盖：空会话、user/conversation 隔离、相同时间戳 id 排序、新主动消息、并发发送、in-flight、路由切换、后台/失焦、恢复前台。额外通过真实 `requireRequestIdentity`（仅其身份提供方用 fixture）验证未登录 401、伪造 owner 403、客户端 UUID 400，均在 messages SELECT 前拒绝。

## 3. Supabase JSON 投影：仍未通过实际 Gate

本轮 Supabase 已登录标签页读取再次超时；没有生产 PostgREST GET 响应，没有数据库写入，也没有为取得证据扩大凭据权限。

已通过离线行为测试，语法符合官方 PostgREST JSON columns / alias 文档：
https://docs.postgrest.org/en/v12/references/api/tables_views.html

**文档与 fixture 不构成此项目实际投影验证。** 当前阻塞不等同于用户账号被 Supabase 拒绝访问。

恢复既有只读连接后，以目标 project `cncpymfqefyabiclnqzg` 执行有限 GET。每种最多 1–3 行，保留生产 owner/role/cursor 条件，不调用 worker endpoint 或写 RPC。输出仅状态、键名、值类型、行数与字节数；不展示 ID、正文、图片、候选描述、完整 JSON、JWT 或 headers。

| 路径 | 需要实际验证的 select | 断言 |
| --- | --- | --- |
| 主动恢复 | `id,conversation_id,created_at,proactiveAttentionCandidates:metadata->proactiveAttentionCandidates` | 非空值为数组，不是字符串；旧缺字段/null 可安全跳过；空数组保留最新快照语义 |
| 自主 Moments | `id,conversation_id,role,content,created_at,imageDescription:metadata->imageDescription` | 描述的字符串/null 类型与原提取一致；alias 名正确；没有 imageUrl/imageUrls |
| 树洞 | `id,role,content,created_at,imageDescription:metadata->imageDescription` | 描述、ID、role、时间均存在；不下载图片字段 |
| Moments interaction 上下文 | `role,content,created_at,imageDescription:metadata->imageDescription` | 与原上下文格式消费一致 |
| Inactivity 恢复第二阶段 | `id,conversation_id,role,content,created_at,proactive:metadata->proactive,replyToUserMessageId:metadata->replyToUserMessageId` | proactive 为 boolean/null（不是文本 true）；reply ID 为 string/null；无完整 metadata |
| 天气上下文 | `id,role,content,created_at` | 正文标准化所需字段完整 |

不能将 empty result 视为验证了非空类型；若生产缺少某类样本，应明确记录该类型未验证，不能插入生产 fixture。SQL Editor 的 JSON 提取只能补充字段证据，不能替代 PostgREST alias/HTTP 验证。

## 4. 发布顺序（当前不执行）

1. 补齐实际 JSON 投影、mobile 回滚目标和真机验证证据。发布前再次只读核对 Production commit；若变更，重新整合而不是覆盖。
2. 保留当前 deployment 和 runtime 匹配的 EAS update group；记录 release commit、原 deployment、production channel/branch、设备 runtime、原 iOS group ID。当前 EAS group 尚未取得，不得虚构。
3. 用户批准后先发布 **Vercel 后端**，来源只能是本集成生产基线。复用现有环境，不修改 Cron/Auth/RLS，也不新增 Function。
4. 后端发布后先以只读 smoke 验证旧 `list/search/context` 与 `latest`、401/403 和空会话，观察原分钟/五分钟 worker 自然运行。不要手动触发会写入的 worker 或 embedding repair 来做验收。
5. 后端稳定后才批准 **手机发布**。仓库是 production channel、runtime fingerprint；必须与设备 runtime 匹配。确认 OTA target 后才发布。若 runtime 不兼容，停止并单独审批 native release。
6. 真机核对原图查看、历史/搜索、新主动消息、focus/blur、前后台、并发发送和无重复 bubble。若验证涉及新消息或任务写入，当前不执行，需在用户另行批准的发布验证窗口进行。
7. 观察部署后的 PostgREST 服务级 usage、请求分布与响应尺寸。没有数据前不报告 MB 节省；分钟/five-minute cadence、Memory capture/retrieval 与 quiet hours 不能变更。

## 5. 可执行回滚方案（仅供另行批准后执行）

### 后端

已核对的回滚目标是当前 `READY` deployment，commit `25ee645`。不要重新部署旧 `05e23cb`，它缺少生产 capture 更新。

```sh
vercel rollback dpl_E4SS4KU5GsvkyoDYP3Af437dftp1 --scope hxj1
vercel rollback status memory-api --scope hxj1
vercel inspect memory-api-beta.vercel.app --scope hxj1
```

回滚后再通过只读元数据确认 Production alias 已指向目标，并验证旧 list/read endpoints；观察自然 worker，无需重建 Memory 或重放 task。不要 reset/delete 数据，保留部署期间正常产生的聊天、Memory 和 task。

集成的新手机已测试支持旧后端，因此紧急后端回滚不依赖所有手机先完成 OTA；降级期间大响应会恢复到旧行为。401/403 不触发该降级。

### 手机

执行目录：`mobile/XiaoC`；使用已有、受信任且登录到本项目的 EAS CLI。本机当前未发现 EAS CLI，本轮未安装或登录。以下先读 channel/updates，再明确选择与当前安装 runtime 相同的原 iOS group；不能盲选最新 group。

```sh
eas channel:view production --json
eas update:list --all --platform ios --limit 10 --json
```

锁定真实旧 group 后，使用该 ID 替换下列变量。这里的值没有预填，不是可以跳过的 Gate：

```sh
task_prior_ios_group='填入已经核对 runtime 的原 update group ID'
eas update:republish --group "$task_prior_ios_group" --destination-channel production --platform ios --message 'Rollback XiaoC Egress Phase 1'
```

官方命令参考：https://docs.expo.dev/eas/cli/ 与 https://docs.expo.dev/eas-update/rollbacks/ 。没有 runtime 匹配 group 时，先确定可用的原 embedded build；不得发布 runtime 不匹配的 OTA。OTA 不是即时全设备切换，应通过启动/下载后的真机状态确认。

### 数据保护

本次无 schema、迁移、向量修改、Memory 删除、图片迁移或 task payload 格式变更。代码回滚不应恢复数据库快照，不删除已经产生的数据。原版 task/message 幂等、terminal lifecycle 和 service mediation 保留。轻量字段投影只用于读取，不用于覆写完整 metadata；写回合并路径仍保留原读取。

## 6. Gate 判定

| 条件 | 判定 |
| --- | --- |
| 生产 Memory capture 完整保留 | PASS：源码逐字比较 + capture 回归 |
| 没有新增测试失败 | PASS：完整基线对照，4 项原失败不变 |
| 关键 Memory/主动陪伴测试通过 | PASS：249/249 |
| 旧客户端兼容 | PASS：离线协议/默认 list；真机 smoke 尚待发布验证 |
| Supabase JSON 投影已验证 | **BLOCKED：没有实际项目响应** |
| 回滚方案 | 后端目标已锁定，新手机/旧后端协议通过；**手机 group/runtime 目标尚待锁定** |

**NO-GO。** 不能将语法文档、模拟客户端或历史审计当成实际投影证据。恢复安全只读连接、补齐投影响应形状和设备/runtime/回滚目标后，再重新判断；本记录不授权发布。
