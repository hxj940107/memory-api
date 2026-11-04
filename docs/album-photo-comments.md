# 新共享照片自动留言 — 2026-11-04

本地实现，待迁移/后端部署/手机OTA/真机验证。

## 产品行为

新照片上传后，复用已有5分钟合批、最多3张原图、同一次Haiku调用。模型分别判断朋友圈和照片下私密留言：可以只留言不发朋友圈、只发朋友圈不留言，或都不做；每批0–3条，每张最多一条。沿用完整人格，不提供成品示例，不要求夸赞/情话/逐项解说。

点相册缩略图进入照片详情：原图、描述、小C的留言。修改分类/时间/权限仍从“编辑”进入。详情页打开且App在前台时每30秒只读刷新留言，切回前台也刷新；刷新不会触发模型。没有手动生成按钮，没有另起评论调用，本期不包含用户回复与自动回评，也没有通知红点。

## 与朋友圈Shadow的关系

`XIAOC_ALBUM_COMMENTS_ENABLED=true` 才启用生成和写入（默认关闭）；关闭不影响已有留言阅读。朋友圈继续保持 `XIAOC_ALBUM_MOMENT_MODE=shadow`，不自动开live。评论开关允许在朋友圈Shadow下写入真实私密留言，这是两个独立动作；`mode=off` 会停止整个新照片批次处理。

复用同一预算：Asia/Shanghai每天最多3次批量看图，08:30–23:30领取，每轮一批。新评论专用领取RPC在朋友圈6小时间隔/日限额/候选池已满/同照片已有配图时，仍可领取做留言，但将allow_post=false，后端会强制shouldPost=false，不能绕过朋友圈门槛。

同一批次没有新增第二次调用，但先前因朋友圈门槛完全跳过的批次，现在可能为留言调用。因此实际总调用可能增加，仍受每日3次共用上限约束。输出预算从420上调至1000，仅开关开启时生效，以容纳三条可选留言及结构化结果；不代表每次都输出这么多。

## 数据与权限

新表album_photo_comments：owner、asset ID、batch ID、正文、时间；RLS开启，仅service_role直读写，unique(user_id,asset_id)使每张照片的自动留言最多一条。照片需本轮实际看过、在本批ID中、owner匹配、shared/enabled/未归档；保存事务再次核对并锁照片，重复执行不重复插入。

同次输出先持久化evaluated，再保存留言、finalize朋友圈。不发朋友圈的结果仍保存comments。评论写入失败时保留evaluated，后续直接恢复写入，不重调模型；评论已写入而finalize失败也幂等恢复。不重跑旧Shadow结果、不为迁移前照片补评论。

GET /api/memory?type=album_assets&action=comments&asset_id=... 复用现有身份解析，先核对当前账号拥有未归档照片，再按owner和asset查询。私人状态可读取自己已有的历史留言，但小C不再获准生成新留言。没有新增Function或schema公开访问。

## 上线步骤

1. 确认之前的supabase_album_moment_upload.sql已执行。在Supabase SQL Editor执行 `supabase_album_photo_comments.sql` 全文；不重新执行旧迁移以免覆盖新逻辑，无需改动旧照片。
2. Vercel Production设置 `XIAOC_ALBUM_COMMENTS_ENABLED=true`，保持 `XIAOC_ALBUM_MOMENT_MODE=shadow`，push部署。
3. 发iOS Production OTA以显示照片详情和留言。
4. 上传新的允许使用的照片，等最后一张5分钟加后台轮询，且满足时间与每日预算。旧已完成批次不会补写留言；不保证每张照片都有留言。

只读验证：

```sql
select id,asset_ids,mode,status,result->'comments' as proposed_comments,candidate_id,
       created_at at time zone 'Asia/Shanghai' as checked
from album_moment_batches where user_id='user' order by created_at desc limit 5;
```

```sql
select asset_id,content,created_at at time zone 'Asia/Shanghai' as commented
from album_photo_comments where user_id='user' order by created_at desc limit 10;
```

本地验证：74项上传/留言/朋友圈定向测试通过；TypeScript noEmit、JS syntax与diff检查通过。全量882项中875通过，7项是上一轮已在HEAD复现的既有失败。Function保持12。本机无PostgreSQL/真机，数据库RPC事务和真实UI显示仍需迁移后验证；未修改线上数据、部署或调用真实模型。
