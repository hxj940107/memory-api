# 相册上传触发朋友圈 — 2026-11-04

本地实现，未部署。无新 API Function、无客户端改动、无 OTA。

## 上线顺序

1. 在生产 Supabase SQL Editor 执行根目录 `supabase_album_moment_upload.sql` 全文（一个事务），再执行下面的只读验收。此迁移新增两张 service_role-only/RLS 表及 RPC/trigger，不回填历史照片。执行成功后只有新插入且 shared/enabled/未归档的照片入队；修改描述、重新授权旧照片不另起事件。
2. Vercel Production 设置 `XIAOC_ALBUM_MOMENT_MODE=shadow`（代码缺省也是 shadow），push 部署。模型沿用集中配置 `AI_MODELS.imageDescription`，当前 Haiku 5.5。`off` 停止本功能领取/生成，不影响相册、聊天或既有发帖路径。
3. 上传一批允许用于朋友圈的照片，最后一张成功入库5分钟后，由已有 background worker 领取（实际还取决于轮询周期、安静时段和频率）。查看下方批次 SQL；Shadow 可以调用模型并保存正文，但不创建 moment_candidates，更不会由本功能发布。既有聊天/自主发帖仍照常运行，不属于此开关。
4. 检查语气、照片引用、事实和费用后，再另行决定是否将环境值改为 `live` 并重新部署；本次不授权/不自动开启 live。旧 Shadow 结果不会补发，旧照片不回跑。

## 行为和限制

- 入队由 DB AFTER INSERT trigger 在上传事务中记录，保证不丢；上传不等待模型。最后一次待处理上传后5分钟合批，每次最早3张，每轮最多领取一批。一次最多生成一条候选、一张配图。超出3张的留队，受预算控制。
- PostgreSQL owner advisory lock 串行领取；同一账号只允许一批 processing/evaluated。每日 Asia/Shanghai 最多3次预占判断，所有预占（含失败/结果未知）均计入，不保证每天发3条。08:30–23:30才领取；共用24小时3条、6小时发布间隔、3条待发候选的前置门槛。
- 已用照片在领取前去重；同一照片跨聊天/新上传候选入库与实际发布时增加数据库去重保护。模型看到最近10条正文、最多3条待发候选与近24小时最多8条用户消息（每条240字符）；近似文本在JS再次过滤，保存事务内做精确去重。不同照片/不同措辞的同一事件语义去重仍不可能完全保证。
- 一次 Haiku 调用同时看图、决定是否发、写正文。不调用主聊天、不另识图或润色、不提供成品文案示例。手机当前上传已缩放到最长1440、JPEG质量0.72；后台使用这份图与低细节输入，不另存原图副本。每批最多3张，不等于每张都发。
- 不把上传时间当拍摄时间。第一版保守禁止正文中今天/今晚/刚刚/待会儿等时间措辞，即使描述写有时间也不自动建立可信拍摄时间；仅传入当前服务器时间供判断。未知时间不编造事件进展。event_time 保存批次处理锚点用于既有候选技术校验，不代表拍摄时间。
- 完整人格 + 公开分享任务，图片和描述是非指令素材。明确不适合公开就不发，不猜人物身份/地点/拍摄者/共同在场，不把她的经历变成小C现实肉身行为。是否适合公开仍由模型判断，不能宣称绝对无误。
- 预占后才签短时URL并调用。数据库只存asset IDs、状态、短原因、候选正文/来源，不保存带签名URL或模型推理。usage/cost沿用 `AI TASK USAGE`，任务名 `album_upload_moment`，查看 Vercel 日志。表为新功能私有审计，不提供 App 直读。
- 成功输出先保存 evaluated，再事务创建候选并标记完成。finalize中断可恢复，无需重调模型。模型异常、格式异常、网络结果不确定不重试生成；processing超15分钟转unknown，不再调用。预调用失败也保守占用名额。可能牺牲一次分享机会来避免重复收费。
- live 候选沿用45–180分钟延迟、24小时过期、现有发布安静时段和频率保护。关闭/Shadow会跳过尚未发布的相册上传候选；撤回共享/启用/归档授权会取消这条来源候选（不是去掉图片继续发正文）。发布入口再查授权，已有消息插入后的任务恢复不重复发布。
- 无相关任务时只查数据库，不调模型。off期间不消费新事件，恢复后可能处理积压的新事件；不扫描迁移前老相册。

## 数据库只读验收（迁移后）

```sql
select to_regclass('public.album_moment_events') as events,
       to_regclass('public.album_moment_batches') as batches,
       to_regprocedure('public.claim_album_moment_batch(text,text)') as claim_rpc,
       to_regprocedure('public.finish_album_moment_batch(text,uuid,boolean)') as finish_rpc;
```

```sql
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in ('album_moment_events','album_moment_batches');
```

```sql
select id, asset_ids, mode, status, candidate_id,
       created_at at time zone 'Asia/Shanghai' as created_shanghai,
       result->>'shouldPost' as should_post,
       result->>'text' as proposed_text,
       result->>'reason' as reason
from public.album_moment_batches where user_id='user'
order by created_at desc limit 10;
```

```sql
select asset_id, status, batch_id, created_at at time zone 'Asia/Shanghai' as uploaded
from public.album_moment_events where user_id='user'
order by created_at desc limit 12;
```

Shadow验收：mode=shadow，status为shadow/declined/unknown/skipped，candidate_id为空；对应新source_type=album_upload不应有候选或帖子。unknown须检查调用日志，不要手动重置processing来重跑付费判断。

## 本地验证

69项上传流程/朋友圈定向测试通过；全部Node测试877项，870通过、7个既有失败。在临时HEAD快照复跑对应失败测试，复现相同7项，未修改它们：background-material-egress、cache-keepalive-pause、context-boundary-fallback、main-chat-temporal-grounding、memory-editing、memory-keys、user-voice。JS syntax/diff检查通过，Function仍12。

本机没有PostgreSQL，因此SQL的事务/锁/trigger尚未在真实数据库执行验证；上线第一步需执行迁移并做Shadow验收，不能将本地mock与SQL源码契约测试等同于真实并发验证。未改生产数据，未付费调用模型，未push或部署。完整人格会增加本功能输入token；不影响主聊天缓存。
