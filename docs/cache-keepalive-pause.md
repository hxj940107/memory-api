# 主动缓存续热暂停

2026-10-30 用户授权暂时关闭主动续热，保留代码，绝不改变正常聊天缓存。本地完成，尚未 push / 部署；无 SQL migration，无 OTA。未修改线上环境变量。

`lib/cacheKeepalive.js` 集中开关 `isBp1CacheKeepaliveEnabled` 只有在 `XIAOC_BP1_CACHE_KEEPALIVE_ENABLED` 精确为 `true` 时返回开启，未设置默认关闭。生产部署前应确保该新变量未被设为 true；显式设为 false 也可。

三处防护：

1. `api/chat.js` 创建续热任务前返回，不读写任务。
2. `api/memory.js` 对已有 bp1_cache_keepalive 任务返回 skipped / bp1_cache_keepalive_disabled，原 worker 正常将任务标记跳过，不发送内部请求，不调用模型。不是关闭整个 background worker。
3. `api/chat.js` 续热专用 action 保留 cron 鉴权，鉴权后在读取 Core Snapshot 及调用模型前返回成功的 skipped no-op，拦住旧 worker 或直接重放请求。

不改 lib/promptCaching.js、Core Snapshot、stable prefix、cache_control、1h/5m TTL、session_id、模型选择和正常聊天请求。正常聊天仍然创建/命中/自然刷新 provider 缓存。暂停只去除后台 synthetic refresh。代码仍保留47分钟的调度与原有45–50分钟执行窗口，可回退。

部署后生效，不撤销部署前已发出的模型请求；无需删除历史任务。恢复时显式设置环境变量为 true 后重新部署，新聊天会重新安排任务，已跳过的旧任务不自动复活。

验证：执行关闭分支，证明 enqueue 无任务I/O、worker无内部HTTP、专用action无snapshot/model并仍鉴权；逐字对比整个 api/chat.js（只排除三个已列明的开关增量）以及缓存、模型请求构造和Core文件，确认正常缓存未修改。另保留原续热功能测试；未进行付费调用或生产请求。
