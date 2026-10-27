# Private App 活动批量接收（本地实现，未部署）

## 范围与前置阅读

本次已阅读 PRODUCT_VISION、DEVELOPMENT_PRINCIPLES、CURRENT_STATUS canonical baseline、memory-context-architecture 和根 AGENTS.md。当前以 CURRENT_STATUS 为准，不把根 AGENTS 中旧 Memory 状态当作重新施工依据。

手机已真机验证小红书、抖音、淘宝的打开/离开事件追加到 `Shortcuts/xiaoc-activity.txt`。锁屏会产生离开，解锁不保证打开；连续离开合法。本功能是粗粒度伴侣互动素材，不推导精确使用时长、当前在线、已读、睡眠、购买行为。不调用模型，不进入主聊天 prompt、Memory、Summary 或主动任务；允许伴侣调侃的产品方向保留，生成接入属于下一阶段。

本提交只实现服务端接收和接入契约。手机上传、游标和本地限频尚未配置/真机验证，不表示小C已能看到活动。没有 push、部署、生产 SQL 或环境变量写入。

## 接口

复用 `POST /api/user-state?action=upload-device-activity`，修改前后 API Functions 均为 12。不能新建独立 api 文件。

请求头 `Content-Type: application/json` 和 `x-xiaoc-activity-token: <独立上报凭证>`。

请求体：

```json
{
  "log": "2026-10-26 22:52:30 | 抖音 | 打开\n2026-10-26 22:52:46 | 抖音 | 离开"
}
```

支持半角 `|` / 全角 `｜`、CRLF / LF、UTF-8 BOM。按 Asia/Shanghai 解析；仅允许这三个 App、打开/离开和有效日历时间。每批最多 300 个非空行、日志最多 64KiB；整批存在非法行时返回 400，不部分确认。超过七天的合法旧记录计入 expired_lines 后丢弃，未来超过五分钟拒绝。相同 App + 动作 + 秒级时间视为同一事件（同秒真正重复切换也会合并），重试幂等。

200 示例：`{"status":"accepted","acknowledged_events":2,"expired_lines":0,"received_lines":2}`。acknowledged_events 是去重后通过校验并完成持久化事务的事件数，包含已存在事件；不表示本次新增行数。存储失败没有成功确认。429 带 Retry-After 和 retry_after_seconds；503 包括开关关闭、缺少配置/迁移或服务不可用。专用凭证不能读取活动或调用其他 user-state action；其他接口仍走原身份验证。

## 尚未执行的上线前置项

1. **用户已执行成功** `supabase_private_device_activity.sql`；随后在 Private 项目 `cncpymfqefyabiclnqzg` 执行 `docs/private-device-activity-validation.sql` 并返回 PASS。已验证 RLS、角色权限、service-role RPC、去重、五分钟限频、上传时过期清理与测试回滚。并发和 HTTP 尚未验证。该 RPC 在每次上传时检查 owner 具有 active companion。
2. 设置 `XIAOC_ACTIVITY_UPLOAD_TOKEN` 为独立随机凭证（至少32字符），不得复用 App token、cron secret 或 service role key。凭证仅放请求头，不放 URL、日志、截图或版本库。轮换环境变量即撤销旧凭证。
3. 复用服务端 `XIAOC_PRIVATE_AUTH_USER_UUID` 绑定私人 owner，拒绝客户端指定 user_id/user_uuid；不修改通用身份 resolver。
4. 显式设置 `XIAOC_ACTIVITY_UPLOAD_ENABLED=true` 后才接受上传，默认关闭。此文不授权执行上述任何生产变更。

每个 owner 的上传状态行通过事务行锁串行化，每五分钟最多接受一批，失败事务不推进时间。网络响应丢失时可能先遇到429，之后重试由事件主键去重，不应删除未确认记录。服务端限频不能阻止手机实际发出请求，手机仍必须实现本地五分钟门槛。

## 手机后续配置契约（待配置）

六条自动化继续共用现有快捷指令，仅在追加文件之后扩展：

1. 保留原文件作为只追加日志；另用状态文件保存已确认行数、上次上传尝试时间。不要每次清空整个日志。
2. 每次事件追加后检查上次尝试时间，未满300秒直接结束；已满则先保存尝试时间，避免失败时每次切换都重试。
3. 读取日志快照，从已确认游标后的第一条开始最多取300行，拼为 log。状态文件不存在时以0初始化，不能将缺文件当作普通读取错误无限停止。
4. 请求上述接口；只有 HTTP 200 且 status=accepted 才将游标推进本次快照的行数（不是 acknowledged_events，后者已去重）。400/413保留游标供排查；401/503暂停排查配置；429和网络失败保留游标，下一次事件到来再尝试。
5. 上传期间追加的新行不在本批快照内，也不能推进游标越过它们。不要使用“读取后清空文件”的方式，以免删除新事件。
6. 快捷指令并发执行的文件状态竞态、锁屏文件访问、失败处理以及权限提示仍需真机验证；不能宣称这个配方已经满足并发可靠性。验证完成前不要让它触发真实主动消息。

不使用长时间等待；没有新事件就不会准时上传。iCloud 文件仅是当前测试位置，同步不等于后端上传。日志轮转时应先停用六条自动化、确认待上传全部处理，再一起归档原日志并重置游标，避免旧游标跳过新文件。自动轮转未实现，本地日志会继续增长。

## 保存与回退

服务器每次成功接收时清理该 owner 七天前记录，并最多保留最新2000条。**这是上传时清理，不是七天到期自动物理删除**；停止上传后数据仍可能留存。当前未新增定时任务，可由维护流程执行 `delete from public.private_device_activity_events where occurred_at < now() - interval '7 days';`，但本次没有执行它。未来消费者必须自行过滤过期线索。

回退先关闭 XIAOC_ACTIVITY_UPLOAD_ENABLED，再关闭手机上传步骤；手机本地采集可独立保留。删除新表前必须先移除依赖的 RPC，并单独确认数据删除；本次不包含破坏性回退脚本。与现有聊天、记忆及主动消息数据无写入关系。

## 验证边界

Node 测试覆盖解析、时间、尺寸/条数上限、幂等ID、凭证隔离、owner拒绝、禁用、节流/失败不确认和真实 endpoint 分发。用户随后执行数据库验证脚本返回 PASS（范围见上）；数据库行锁并发和真实 HTTP 仍未验证，不能由单会话 SQL 或 Node mock 推断通过。

## 手机配置第一步：初始化独立状态文件

最新真机结果：用户已完成初始化，实际文件名为 `xiaoc-activity-upload-state.txt`（内容仍为 JSON）。读取、批次预览已通过；独立状态测试 v2 返回 PASS，证明模拟文件的写入/读回、时间一致和进度0→0→2。使用上传候选 v3，含已验证的保存参数修正；实际 HTTP 和自动化接入未完成。以下最初的 .json 初始化配方仅为历史过程，不应重置用户当前的 .txt 文件。

另建一次性快捷指令“小C上传初始化”，添加“文本”，内容为下方 JSON；再添加“存储文件”，输入选择该文本，文件夹选当前日志相同的 Shortcuts，关闭“询问存储位置”，子路径为 `xiaoc-activity-upload-state.json`。首次创建不要覆盖已有状态文件。此快捷指令不接任何自动化，只手动运行一次。

```json
{"version":1,"acknowledged_lines":0,"last_attempt_at":"2000-01-01T00:00:00+08:00"}
```

这是状态文件初始化，不是可运行的上传器。后续读取日志快照、时间门槛、游标更新步骤仍需逐项配置和真机验证。上线后不要再次初始化为0；否则会重传旧记录（服务端仍去重）。
