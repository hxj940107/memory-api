# 主动联系判断与 App 生活线索修复

状态：本地完成，尚未 push / 部署；不需要 SQL migration 或 iOS OTA。

## 生产证据

2026-10-30 用户提供：后台截至18:35运行224次，无失败；任务51952于13:00以 `inactivity_paid_budget_exhausted` 结束。预算52265为 ordinary=2、ceiling=2，无候选；任务保存的最后判断为 should_send=false、model_declined、topic_state=completed，动机为旧哄睡话题已结束且无合适具体话题。此前没有逐次判断历史，不能还原四次模型输出，也不能把四个预留名额直接当作四次已确认付费请求。

## 本次边界

- 调整 inactivity 专用 prompt：具体事件不是联系前提，亲昵短句、想念、撒娇与想陪伴本身成立；frequent 明确影响生成意愿。旧睡前消息不能作为当前仍在睡的证据；相似关系动机不再被等同于重复消息。
- 复用已有到期 inactivity 任务，在预算预留后、原有单次模型调用前读取可选 App 活动。仅 Private legacy `user` 映射到已配置 Private Auth UUID；其他 owner 不读。沿用800ms、24行查询上限，表达素材只取近30分钟，沿用近期App提及抑制。失败/缺配置/无新信号时为空。
- `XIAOC_ACTIVITY_UPLOAD_ENABLED=true` 时默认允许该素材；可用 `XIAOC_ACTIVITY_PROACTIVE_CONTEXT_ENABLED=false` 独立关闭，不与主聊天素材开关绑定。
- App 活动不会直接创建主动任务，不触发额外模型调用，不改变 Attention Eligibility。素材可用不代表当前一定在刷、故意不回复或看过具体内容。勿扰与提及边界优先。
- 不改普通/最终各2次的预算、quiet hours、原子预留、发送幂等和最终消息推进复核；不加固定兜底文案，不强制接受模型拒绝。它是判断规则修复，尚不能保证真实模型不再拒绝。
- 预算 payload 新增最多4条 `generation_attempts`：预留时间、阶段、计数、完成时间和有限判断字段。`reserved` 可能代表中断，不等同完成调用。完成记录不保存 raw completion 或被拒正文；contact_motivation 是最长160字符的有限诊断理由，可能包含少量私人语境，不应公开分享。
- 不重置已用完的线上预算，不自动恢复今天已终止的任务，不补发消息。部署后的新沉默窗口会使用新逻辑；旧窗口不会因为改 prompt 获得额外次数。

## 检查

新增测试执行真实生成函数的 prompt 组装（模型输出为合成 fixture），覆盖旧话题结束时关系表达可接受、频率/最终机会和活动素材接入、仍为单次生成、quiet hours 无调用；验证 owner隔离、过期/重复/失败信号降级、四次判断记录及预算不扩张。保留其余 prompt、人格、主聊天组装的比较保护。

完整 Node 回归844项，840通过，4项失败；在当前 HEAD 的独立临时副本中复现同样4项旧失败（main-chat-temporal-grounding、user-voice、memory-editing、memory-keys），不是本次引入。没有进行付费模型评测或生产发送测试。JS语法与diff检查通过，API Functions仍12/12。

## 同日补充：最后名额只生成表达

用户确认后，第二个 ceiling 生成名额改为 expression-only（若没有使用普通阶段名额，它仍是当前窗口最后可用的 ceiling 名额，不虚构额外次数）。模式由原子预算预留结果传给生成器，不从可重建的 task.payload 推断；缓存候选重试发送不消耗名额，也不重生成。

继续使用同一人格与同一 inactivity prompt，仅在当前任务说明及同一 JSON 输出约定中标记：本次只决定怎样表达，不需要 should_send 字段。解析时仅在此模式允许缺省 should_send；明确返回 false、空 message、坏 JSON、身份/时效/事实等不合格内容仍拒绝。普通模式保持原要求。不增加调用次数，不添加固定成品文案，不绕过勿扰或发送复核，不恢复已经耗尽的旧窗口。这是表达机会兜底，不承诺任意模型输出都能发送。

新增测试覆盖最后名额选择、缓存重试不占名额、实际生成函数只调用一次、最终格式缺省 decision 的解析，以及空/坏/明确拒绝仍拦截。
