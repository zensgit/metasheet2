# 自动化 × 数据管道：用「运行集成作业」动作与「作业运行完成」触发器把两台引擎连起来，替换 OS 定时任务并补失败告警（ADR 2026-11-03）

> **状态**：草稿 v1。owner 2026-11-03 对主会话「两台引擎保持独立、只做连接、不建第三台」的提案回复「批准写 1a 的 ADR」；本 ADR 即 1a。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决；标「待 owner 裁定」的条目在 §12 汇总，未裁定前不开 1b。
> **线别**：备料接管线的交付项（「替换 OS 定时任务 + 失败告警」），比照 R-50 对 #6315 的框定，不算第三条线；本 ADR 不解封 #6323 / #6324 / #6337。
> **基线**：main `8f3867da7`（`8f3867da790333b3974e6c9db8df129b786bb3d6`）。下文所有 `path:line` 都在这个提交上核过；新增文件只写路径不写行号。合并前若 main 已前进，按章程 rebase 后重核行号。
> **values-free**：不含主机、地址、口令、令牌、租户名、账号名或任何客户值，只指位置；「222」只是客户测试机在本目录文档里的既有代号。
> **关联**：R-42（两条线）、R-50（框定范式）、R-69（本 ADR 的登记行，PROPOSED）；`docs/integration-consolidation-plan-20260901.md` §4 动作三与 `:4` 的勘误；`docs/integration-consolidation-minimal-plan-20260901.md` §6.1（`run_integration_pipeline` 动作与 `IntegrationRunPort`）；`project-subtree-bridge-design-20260905.md` §2（定时拉取为什么落在 OS）；`222-deploy-window-runbook-20260901.md` 「定时拉取」节；`adr-yida-connection-test-20261028.md`（宿主私有运行时 / 插件能力的分工范式）。
> **来源**：客户的备料拉取今天由 OS 任务计划程序运行 `scripts/ops/stock-preparation-scheduled-pull.mjs` 经 HTTP 发起，失败无人知道。主会话读码后建议：两台引擎（multitable automation、data-factory pipeline）保持独立、用两座桥连接；owner 2026-11-03 批准先写 ADR。owner 同日追问「能直接借鉴 n8n 的框架底座么」，答复见附录。

**裁决记录**

| # | 问题 | 裁决 | 层 | 落在哪里 |
|---|---|---|---|---|
| Q1 | OS 任务跑的到底是什么 | **不是管道**：脚本打的是备料表动作 `dry-run → apply`（`stock-preparation-scheduled-pull.mjs:377-381`），`pipelines/:id/run` 从未被它调用。所以 Bridge 1 的动作是「运行集成作业」`run_integration_job`，作业种类闭集 `{stock_prep_pull, pipeline}`；1b 先交 `stock_prep_pull`（这才替换得了 OS 任务），`pipeline` 种类走同一条受治理入口 | 待 owner 裁定（偏离已批提案的措辞，§12 OQ1） | §1.5、§3 |
| Q2 | 动作落在 core 还是插件 | core 执行器持有动作类型、校验、幂等台账与审计；插件在激活时向 core **登记**一个 `IntegrationRunPort`（插件→core 的端口，与 `workdayCalendar.register` 同形，`index.ts:1768-1778,2812-2815`），只对 `plugin-integration-core` 开放；端口缺席即失败关闭。不走 `communication.call`，不自调 HTTP | T 层默认 | §2 ②、§3.2 |
| Q3 | 运行身份绑定给谁 | 授权主体 = 规则创建者，**保存时冻结**、每次触发**实时复核**；数据面读身份保持今天的服务端 `dataSourceOwnerId`（`http-routes.cjs:6472-6485`），不随规则变；无租户声明的主体在保存时即拒绝 | T 层默认 | §6 |
| Q4 | 重试 | 只在写入段**之前**失败（授权/加载/读源/变换）才由动作层有界重试（≤3 次、≥60 s 间隔）；写入段已开始且目标非幂等即 `outcome_unknown`、永不自动重试；行级数据错误留在既有死信。runner 本身不加重试循环 | T 层默认 | §5 |
| Q5 | 同一管道同时只跑一次 | 代码里**已有** DB 级围栏：`uniq_integration_runs_one_running_per_pipeline`（`058_integration_runs_running_unique.sql:34-36`）+ 应用层 409（`pipelines.cjs:34,729-735`）；主会话「没有锁」的线索不成立。动作把 409 视为 `skipped(busy)`，不算失败；作业超时必须小于 4 h 的陈旧回收阈值（`pipelines.cjs:897`） | T 层默认 | §3.4 |
| Q6 | Bridge 2 事件形状 | 新触发器 `integration.run_finished`：每次运行恰好一条 values-free 摘要（状态 + read/cleaned/written/failed 计数 + 时长 + 错误类别），**没有逐行事件**；按作业 id 路由的专用派发路径（与 `approval.completed` 同形），不进 `TRIGGER_TYPE_BY_EVENT` | T 层默认 | §4 |
| Q7 | 告警 | 复用 `send_dingtalk_group_message` / `send_dingtalk_person_message`，1c 只交一个规则模板，不建告警系统 | T 层默认（真实群 = O ④，§12 OQ5） | §4.3 |
| Q8 | 开关 | 三个新 env 开关，默认关、只认原文 `true`、登记 flag manifest：`INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED`（Bridge 1）、`INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED`（Bridge 2）、`INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED`（无人值守套用，O ②） | T 层默认（第三个开关的打开 = O 层） | §7 |
| Q9 | 时区 | 含本动作的 cron 规则**必须带** IANA 时区，缺省填业务时区（`MULTITABLE_BUSINESS_TIMEZONE`，默认 Asia/Shanghai）；不带时区即保存拒绝（今天缺省是 UTC，`automation-scheduler.ts:196-205`） | T 层默认 | §3.5 |
| Q10 | 审计记谁 | 自动化执行行记 `triggered_by='schedule'` + 规则 + 创建者；`integration_runs` 新增 `triggered_by='automation'` 词项，`details.automation = {ruleId, executionId, triggerType}` 只放标识；备料审计行的 actor = 绑定主体，另加 `source: 'automation'` | T 层默认 | §9 |
| Q11 | 管道 / 项目在规则创建后变了 | 保存时冻结管道指纹（源/目标系统 id、对象、模式、映射的 sha256，与 FWB `confirmationHash` 同形 `automation-actions.ts:78-85`）；触发时不符即 `skipped(pipeline_changed)` 并发 Bridge 2 事件；项目不存在 / 已归档沿用脚本语义记 `skipped` | T 层默认 | §3.3 |
| Q12 | 无人值守套用（apply） | 不在 1b；默认 `applyMode: 'dry_run_only'`。`apply_when_ready` 是写客户表的生产写入（章程 O ②），要第三个开关 + owner 逐部署批准；生产策略仍只认服务端配置（`stock-preparation-production-policy.cjs:5-16`） | 待 owner 裁定（§12 OQ2） | §3.6 |
| Q13 | 调度主失效 / 进程中途崩溃 | 主失效只清计时器不中止在途回调（`automation-scheduler.ts:469-483`），新主再触发撞 DB 围栏即 `skipped(busy)`；崩溃留下的 `pending` 意图行在下次认领时翻成 `outcome_unknown`（`automation-outbound-intent.ts:117-127`），由动作层以 `not_started/outcome_unknown` 摘要事件告警 | T 层默认 | §3.4、§4.2 |
| Q14 | 绑定数据源的 owner 被停用 | 今天宿主只比 owner 相等、不查在役（`DataSourceManager.ts:789-799`），HTTP 路径亦然；本 ADR 只实时复核**授权主体**的在役与权限，绑定 owner 停用是否应停拉取交 owner | 待 owner 裁定（§12 OQ4） | §6.3 |

---

## 0. 为什么

1. **失败无人知道。** OS 任务只把一行 JSON 写进脚本自己的日志，产品内没有记录「这次定时拉取本身」的审计动作，失败次数与原因只能去日志文件或任务计划程序的历史里查（`222-deploy-window-runbook-20260901.md:930-937`）。
2. **调度能力在 core 里已经有了，缺的是把作业接上去。** 平台有 cron / interval / date_field 调度器 + 可选 Redis 主选举（`automation-scheduler.ts:1-6,44-58`），但动作类型表里没有「跑一个集成作业」（`automation-actions.ts:6-33`）——这正是脚本头注释 (2) 与 `project-subtree-bridge-design-20260905.md:80` 当时放弃进程内调度的原因；补这一项是 core 改动，不是运维脚本。
3. **插件侧也没有调度器。** `'cron'` 在整个插件里只出现在词表 `pipelines.cjs:30`，没有任何代码产出 `triggeredBy: 'cron'`（runner 缺省 `'manual'` `pipeline-runner.cjs:918`，所有路由盖 `'api'` `http-routes.cjs:7597,7632`）；`integration_schedules` 表（`057_create_integration_core_tables.sql:165-177`）建了却没有任何写入方或读取方。两份收敛方案都已裁定不接活它（`integration-consolidation-plan-20260901.md:4`，`integration-consolidation-minimal-plan-20260901.md:284`）。
4. **不建第三台引擎。** 两台引擎各自的安全性质（自动化的两阶段意图/`outcome_unknown`/事件去重；数据工厂的 B2a 读围栏、C6 写生命周期、K3 永久禁写、死信）都是花过代价才有的，连接比重建便宜，也不引入新的授权面。

## 1. 现状与约束（读码结论）

### 1.1 自动化引擎

- **动作与触发器闭集**：动作 16 种（`automation-actions.ts:6-33`，`ALL_ACTION_TYPES :35-52`）；触发器 11 种（`automation-triggers.ts:6-17`）。记录事件经 `TRIGGER_TYPE_BY_EVENT`（`:87-92`）；`approval.completed` / `approval.task_created` 走按模板 id 路由的专用派发路径，不经该表（`:57-63`；`automation-service.ts:4080-4125`）。新类型要改 DB CHECK：触发器 CHECK 最后一次重建在 `db/migrations/zzzz20260705140000_add_approval_task_created_trigger_type.ts:14-27`，动作 CHECK 在 `zzzz20260720120000_add_write_approval_form_values_automation_action.ts:28-34`——1b、1c 各带一支迁移。
- **调度器**：cron 五段式、UTC 分钟分辨率（`automation-scheduler.ts:151-163`），可带 IANA 时区（`:171-183`，缺省/非法回落 UTC `:196-205`，保存时校验 `automation-service.ts:2781-2796`）；下一次出现用逐分钟扫描（`:252-287`）；触发后从「现在」重排、不补发（at-most-once，`:527-534`）；interval 用 `setInterval`（`:614`）。**没有按规则的在途互斥**：`runScheduledRule` 只把回调放进 `inFlight` 供停机排空（`:490-504`），下一跳到了就再触发一次。主选举是可选项：`ENABLE_SCHEDULER_LEADER_LOCK === 'true'` 且 Redis 可用才建锁（`automation-service.ts:1398-1408`）；没有锁即永远当主（`automation-scheduler.ts:383-388`）；失主只清计时器（`:469-483`），不中止在途回调。该开关在 flag manifest 里**未登记**（`scripts/ops/global-history-flag-manifest.mjs:51-850` 的键表里没有）。
- **定时回调**：先查表是否在役，再 `executeRule(rule, { _triggeredBy: 'schedule' })`（`automation-service.ts:1500-1527`）——record-less、无 actorId；执行上下文携带 `ruleCreatedBy` 与可空 `actorId`（`automation-executor.ts:1552-1560`）；跨库写门按规则创建者裁（`:4328`）；钉钉群目标按 (sheet, 创建者) 绑定（`:6029`）。执行行落 `triggered_by`（`automation-log-service.ts:39,83`，列缺省 `'event'`，`zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts:23`）。
- **规则表**：`automation_rules(sheet_id, trigger_type, trigger_config, action_type, action_config, actions, created_by …)`（`zzzz20260413120000_create_automation_rules.ts:24-37`，`zzzz20260414100000_extend_automation_rules.ts:24-27`），**没有 tenant_id 列**；规则只挂在表上。创建规则的门是该表的 `canManageAutomation`（`routes/univer-meta.ts:22008,22018`），= 平台管理员或 `workflow:*` 权限（`sheet-capabilities.ts:106-111`）；`createdBy` 取自认证用户（`univer-meta.ts:22025`，落库 `automation-service.ts:1771`）。
- **外发两阶段**：意图行先提交（Tx A）→ 一次尝试 → 结果行（Tx B，`WHERE status='pending'` 单写者）；`pending` 残留在下次认领时翻成 `outcome_unknown`、永不自动重发（`automation-outbound-intent.ts:95-140,148-165`）；分类：2xx=sent、DNS/拒连/TLS=failed（可重试）、其余=unknown（`:230-239`）；开关 `AUTOMATION_CLASSB_OUTBOUND_ENABLED === 'true'`（`:63-65`）。`send_webhook` 的用法在 `automation-executor.ts:4699-4766`。
- **幂等键**：`deriveActionKey` = JSON 数组编码的 (结构路径, 动作类型, sha256(规范化配置)[:16])（`automation-action-idempotency.ts:58-64`）；class-A 同事务认领（`:89-113`）；`classifyOutboundOutcome`（`:133-140`）。
- **重试资格**：class-A = 四种记录写，class-B = 五种外发（`automation-retry-eligibility.ts:18-31`）；未知动作类型在真发测试里是 `TEST_RUN_ACTION_UNSUPPORTED`（`:76-78`）；重试窗口 7 天（`:144-149`）；台账证据只对 A/B 两族要求（`:167-196`）；`retryExecution` 的拒绝码在 `automation-service.ts:3510-3558`，路由仅管理员（`routes/automation.ts:1091`）。
- **耐久投递**：`AUTOMATION_DURABLE_DELIVERY_ENABLED`（trim + 小写后等于 `true`，`automation-durable-delivery.ts:20-22`，与其它开关的 byte-exact 不同）；开则 outbox 替换（不是并存）旧总线 emit（`automation-producer-emit.ts:1-25`）；事件族由版本化路由清单声明，新族 = 新版本（`automation-routing-manifest.ts:80-92,99,126-136,179-188`）。去重键 `${eventType}:${_eventId}`（`automation-event-dedup.ts:17-26`）；`runWithEventDedup` 在开关关时用一次性认领、开时用租约（`automation-service.ts:2464-2484`；租约原语 `automation-event-fires-lease.ts:26-65`）。递归上限 `MAX_AUTOMATION_DEPTH = 3`（`automation-service.ts:143`）。
- **入站 webhook**：HMAC-SHA256 over `${timestamp}.${body}`、300 s 重放窗、60/分钟限流、统一 401（`automation-inbound-webhook.ts:3-11,52-59,69-99`；路由 `routes/automation.ts:447-464`）。本 ADR 不动它。
- **插件路径的记录写不产生自动化事件**：插件 API 的 `createRecord` 在事务里过写围栏后直接调 `createMultitableRecord`（`index.ts:1302-1320`），`records.ts` 只写修订（`:762` 注释），不 emit；`'multitable.record.created'` 的发射点只有 `record-service.ts:1015,1062,1589`、`automation-executor.ts:3989,4000`、`approval-fwb-write-action.ts:204`。主会话这条线索**成立**。所以「拉取写了多少行」永远到不了 `record.created` 触发器——Bridge 2 必须是摘要事件，不能寄望行事件。

### 1.2 数据工厂（plugin-integration-core）

- **受治理的 HTTP 入口**：`POST /api/integration/pipelines/:id/run`（`http-routes.cjs:58`）先 `requireAccess(req,'write')`（`:7585`；权限梯 `integration:read/write/admin`、`role:admin`，`:1339-1355,1367-1376`），再 `assertPipelineRunAllowed`（`:6318-6340`：armed 部署下对 `metasheet:multitable` 目标的非试算运行答 403 `C6_SAFE_LIFECYCLE_REQUIRED`，然后做 B2a 读授权），然后盖 `triggeredBy:'api'`、`runAs:'user'`（`:7597,7599`），**只在这里**附 `C6_WRITE_LIFECYCLE_CONTEXT`（`:7613`）。试算路由同形、不附写标记（`:7618-7638`）。
- **runner 级 C6 写围栏**：`assertC6WriteLifecycleContext` 在 `runPipeline` 与 `replayDeadLetter` 的第一行（`pipeline-runner.cjs:658-693,905,1233`）；armed-scoped（`:687`）；非试算且无标记即拒绝。K3 WISE 实写是 C6-only、在 runner 里直接拒（`:452-458`）。
- **跨插件通信 API**：`communication.register('integration-core', …)`（`index.cjs:601-602`）暴露的 `runPipeline` 先剥掉两个服务端专有标记、再强制 `runAs:'service'`（`:178-188,259-271`）——所以 armed 部署下跨插件试算可以、写入被拒；这是正确姿态，本 ADR 保留且不新开第二条绕路。
- **运行身份**：runner 以 `principal: pipeline.createdBy` + `runAs` 解析源/目标连接（`:414-431`）；`'user'` 只有受治理 HTTP 能盖；连接解析器只在 `runAs === 'user'` 且有主体时走 owner 兼容路径（`connection-resolver.cjs:275,307,395`）。宿主数据源门是**严格 owner 相等**，平台管理员例外（`DataSourceManager.ts:789-799`）。
- **一管道一在途运行**：部分唯一索引（`058_integration_runs_running_unique.sql:34-36`）+ 应用层 409（`pipelines.cjs:34,438-443,729-735`）；每次运行前先回收超过 4 h 的 `running` 行（`:893-927`，调用点 `pipeline-runner.cjs:943-955`）。**主会话「没有按管道的锁」不成立。**
- **运行结束**：`rowsFailed > 0` 或翻页到顶 = `partial`，否则 `succeeded`（`:1173`）；`finishRun` 失败只记 `FINISH_RUN_FAILED` 警告、不抛（`:1190-1197`，注释明说是防调用方重试造成重复写）；抛错路径记 `failed`（`:1205-1221`）；水位只在成功后推进（`:1161-1170`；类型 `updated_at | monotonic_id`，`watermark.cjs:6`）。**runner 没有任何重试循环**（`:1193,1345` 只是关于调用方重试的注释）。
- **死信**：`open | replayed | discarded`（`dead-letter.cjs:7`），`retryCount`（`:81,165-174`）；回放永远是实写、要 C6 标记（`pipeline-runner.cjs:1227-1233`），非 `open` 或载荷截断即拒（`:1246-1259`）。
- **词表**：`VALID_TRIGGERS = {cron, manual, api, replay}`（`pipelines.cjs:30`）；`integration_runs.triggered_by` 无 CHECK、只有注释（`057:105`）。

### 1.3 今天的 OS 定时任务（备料拉取）

- 脚本是普通 HTTP 客户端，顺序打 `table-actions/plm.stock-preparation.pull-bom.v1/dry-run` → `…/apply`（`stock-preparation-scheduled-pull.mjs:377-381,540-560`），缺省只试算（`:25-30,147-149`），输入只来自环境变量（`:70-73,123`）；令牌须为**租户绑定**的服务账号（`:32-50`，否则 `--allow-tenantless` 才放行）。
- 两枪必须同一次运行：试算令牌一次性、30 分钟 TTL（`stock-preparation-table-actions.cjs:169-170,2001`），套用消费令牌并比对修订（`:2142-2158,3228,3304`）。套用默认只允许沙箱目标，生产策略只认服务端配置（`stock-preparation-production-policy.cjs:5-16,36`）。目标表有跨进程写锁（租约 + 计划代号，`stock-preparation-project-write-lock.cjs:1-45`，迁移 100）。
- 表动作的门：`requireTableActionAccess`（`http-routes.cjs:1440-1466`）——持 legacy `integration:*` 即放行并跳过 operator-scope；否则要 `operatorMayRunStockPrepPull`（`:1453`）+ 作用域解析。读身份对这一个 actionId 用服务端盖章的 `config.dataSourceOwnerId`（`:6472-6485`；盖章与剥除 `external-systems.cjs:30-34,480-482,515`）。
- **x-tenant-id 历史**：鉴权中间件在令牌无租户声明时把请求头 `x-tenant-id` 填进 `user.tenantId`（`http-routes.cjs:1414-1415,1574,1644` 注释）；`resolveTenantId` 对租户绑定主体强制相等、对无租户平台管理员采信请求（`:1476-1498`）；硬门 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED`（`:1764-1766`，`assertVerifiedTenantClaim :1668-1671`）默认关。脚本头注释与 runbook 都因此要求租户绑定令牌（`222-deploy-window-runbook-20260901.md:852-866`）。
- 222 上已注册每日 06:00、只试算的计划任务，令牌为专用服务账号（`48h-autonomous-run-record-20260906.md:32,56`）；runbook 列出的已知限制：试算令牌记录只在被套用时删除、高频试算会累积；产品内无该任务的审计（`:930-937`）。
- 部署形态：pm2 单 fork（`ecosystem.config.cjs:60-61`）——今天没有第二个调度器，主选举开关的缺席不构成风险。

### 1.4 与两份收敛方案的关系

- 总方案 §4 动作三曾提议「照 automation-scheduler 模式给 `integration_schedules` 接一条写入方」（`integration-consolidation-plan-20260901.md:112-119`，§7 P2 `:151`），其 `:4` 勘误已改口为「复用 Automation + IntegrationRunPort」。本 ADR 采纳勘误：**不接活 `integration_schedules`**，它留作死表待另案删除。
- 最小方案 §6.1 提议动作 `run_integration_pipeline`、宿主 `IntegrationRunPort.request()`、持久化 `integration_run_requests`、独立 Worker、至少一次队列（键 `triggerId + scheduledFor`）（`integration-consolidation-minimal-plan-20260901.md:282-298`）。本 ADR 保留「宿主端口 + 触发器不授予外部写权 + 不可经 HTTP/自 webhook 绕围栏」三条，**去掉**独立 Worker、请求表与至少一次队列：自动化执行器就是 worker，`integration_runs` 行 + 唯一索引就是去重，调度语义沿用调度器的 at-most-once（今天的 OS 任务同样是每日一次、不补发）。动作名改为 `run_integration_job`，原因见 Q1。

### 1.5 主会话线索与代码的四处不一致（代码为准）

1. **「替换 OS 任务 = 给管道一个调度」**：OS 任务跑的是备料表动作，不是管道（§1.3）。只做「运行数据管道」替换不了它。→ Q1。
2. **「runner 里没有按管道的锁」**：有，且是 DB 级（§1.2）。→ Q5 改为「正确对待 409」。
3. **「append 模式的管道」**：管道没有 append/upsert 之分；`mode` 是读模式 `incremental | full | manual`（`pipelines.cjs:28`），目标适配器只有一个写入口 `upsert`（`pipeline-runner.cjs:669-671`）。幂等与否取决于**目标种类**，不是模式。→ §5 按目标种类分类。
4. **「有界重试放在管道内部」**：runner 没有重试机制（§1.2）；在 runner 里加循环会改动所有受围栏保护的路径。→ Q4 放在动作层、只对写入段之前的失败。

## 2. 决策清单（锁定）

① **两座桥、零新引擎**：Bridge 1 = 动作 `run_integration_job`；Bridge 2 = 触发器 `integration.run_finished`。不做可视化画布、不做逐行事件、不经跨插件通信 API 写、不做无人值守宜搭发送、不做用户自定义连接器种类。

② **core 持动作，插件供端口**。动作的类型、保存校验、幂等台账、重试分类、审计落在 core（`automation-actions.ts` 的联合类型与两支 CHECK 迁移都在 core）；运行本体与全部围栏留在插件。插件在 `activate` 时向 core 登记 `IntegrationRunPort`（`context.services.integrationRun.register(port)`），core 按插件名记 owner、卸载/重载即解绑、缺席即 `INTEGRATION_RUN_PORT_INACTIVE` 失败关闭——与 `registerPluginWorkdayCalendarProvider`（`index.ts:1768-1778,1780-1790`）同形，且像 `yidaOwnerRuntime` 等能力一样只对 `plugin-integration-core` 开放（`index.ts:3623-3633`）。宿主→插件的既有能力方向（`index.ts:2788-2793`）不变。为什么不是 core 直接 `require` 插件库：会把插件的 B2a/C6 围栏搬进 core 的依赖图，等于绕过插件激活块与 s6a 来源 pin。为什么不是宿主私有运行时（宜搭范式）：宜搭运行时是 core 拥有授权与事务、插件只做组合（`yida-owner-runtime.ts:9-12`，`yida-owner-runtime-factory.mjs:5-8`）；本案的授权与写围栏本来就在插件里，搬家才是风险。

③ **插件侧新增 req-less 的受治理入口**：把 `http-routes.cjs` 里 `pipelinesRun` / 表动作 dry-run+apply 的授权链（`requireAccess` 或 `requireTableActionAccess` → 租户解析 → `assertPipelineRunAllowed` / `assertB2aStockPreparationReadAuthorized` → 读身份委派 → 盖 `runAs:'user'` 与写标记）抽成接受 `{ principal, tenantId, … }` 的函数，HTTP 路由用 `req` 构造主体后调用它，端口用冻结的绑定主体调用它。**同一段代码、两个调用方**，不得出现「端口版」的第二套检查。端口**从不**暴露 `replayDeadLetter`。

④ **三个开关**（§7）：Bridge 1、Bridge 2 各一个；无人值守套用单独一个。保存时与每次触发时都读原文；关着的动作在触发时记 `skipped(action_disabled)`，不静默成功。

⑤ **一次运行一条摘要事件**，由插件在 `finishRun` 之后经第二个端口 `integrationRunEvents.publish(summary)` 送进 core；core 按闭合键集校验（与 `yida-owner-runtime-factory.mjs` 的 `record()` 同样拒多键、拒 Proxy），再按作业 id 路由。动作层对「没跑起来」的终态（`skipped` / `not_started` / `outcome_unknown`）自己补发一条摘要，保证每个动作步恰好对应一条事件。

⑥ **幂等与重试按目标种类分类**（§5），不按模式。

⑦ **cron 必带时区**（Q9）；含本动作的 interval 规则 `intervalMs ≥ 15 min`；作业超时 `timeoutMs ≤ 3 h`（< 4 h 回收阈值）；两者在保存时校验。

⑧ **词表变化**：`VALID_TRIGGERS` 增 `'automation'`（`pipelines.cjs:30`；`057:105` 只是注释，无 CHECK）；`automation_rules` 的动作 CHECK 增 `run_integration_job`（1b 迁移）、触发器 CHECK 增 `integration.run_finished`（1c 迁移），up/down 同 `zzzz20260720120000…:28-43` 的形式。

## 3. Bridge 1：动作 `run_integration_job`

### 3.1 配置形状（闭合键集，保存时逐键校验）

```
{ job: { kind: 'stock_prep_pull', projectNos: string[≤20], applyMode: 'dry_run_only' | 'apply_when_ready' }
| job: { kind: 'pipeline', pipelineId, pipelineFingerprint, mode?: 'incremental' | 'full' | 'manual' },
  timeoutMs ≤ 3h, retry: { maxAttempts ≤ 3, backoffMs ≥ 60000 },
  binding: { principalId, tenantId }  // 服务端盖章，客户端值一律丢弃（同 dataSourceOwnerId 的做法）}
```

- `job.kind` 之外的键、未知 `applyMode`、`mode` 不在 `VALID_MODES`（`pipelines.cjs:28`）、空 `projectNos`、`pipelineFingerprint` 缺失或不等于服务端重算值 → 保存 400。
- 规则的 `sheet_id` 对 `stock_prep_pull` 必须是这些项目**已登记**的目标表（项目登记表 087，R-66/R-68 口径）；对 `pipeline` 且目标是 `metasheet:multitable` 时必须等于管道目标表；其它目标种类要求创建者对该表 `canManageAutomation` 之外另持 `integration:admin`。这样「谁能在这张表上建自动化」与「谁能跑这个作业」两道门同时成立。

### 3.2 执行序（每次触发）

开关原文判定 → 端口在役 → **实时复核绑定主体**（在役、仍持 §6 要求的权限、租户未变）→ 管道指纹 / 项目状态复核 → Tx A 认领意图（`claimOutboundIntent`，kind=`execution`、`actionKey = deriveActionKey(…)`；`sent/outcome_unknown` 即 `alreadyApplied` 跳过）→ 端口 `run({ principal, tenantId, job, timeoutMs, automation: { ruleId, executionId, triggerType } })` → 插件受治理入口（§2 ③）→ runner / 表动作 → 返回 values-free 结果 `{ runId?, status, counts, durationMs, failureStage?, errorClass? }` → Tx B 记结果 → 动作步结果 → 动作层补发摘要（§4.2）。

- `stock_prep_pull`：逐项目顺序执行，先试算；`applyMode = 'apply_when_ready'` 且第三个开关为 `true` 且试算 `ready && canApply` 才在同一步里用刚拿到的令牌套用（与脚本 `:148-150,540-560` 同语义）；`manual_confirm_required`、`PROJECT_ABSENT`、`PROJECT_ARCHIVED` 记 `skipped`，不算失败（脚本 `:552-560` 的口径）。脚本不传、动作也**不传** `acceptManualConfirmHold / acceptDuplicateResolution`：冲突留给人。
- `pipeline`：端口调用受治理入口的非试算运行；armed 部署下 `metasheet:multitable` 目标照样 403 `C6_SAFE_LIFECYCLE_REQUIRED`（`http-routes.cjs:6325-6333`）——动作不替任何人完成 C6 生命周期，这类管道在自动化里只能 `dryRun`（配置 `dryRun: true` 可选，缺省 false）。

### 3.3 绑定变化

管道：保存时服务端算指纹 = sha256(规范化 `{sourceSystemId, targetSystemId, sourceObject, targetObject, mode, fieldMappings}`)；触发时重算不等 → `skipped(pipeline_changed)`；管道非 `active` → runner 自己拒（`pipeline-runner.cjs:408-413`）→ `failed`。项目：登记表里不存在 / 归档 → `skipped`。表被软删 → 调度回调已跳过（`automation-service.ts:1511-1516`）。

### 3.4 并发、重叠与失效

- 同管道并发：DB 唯一索引 → 409 → 动作记 `skipped(busy)`，Bridge 2 事件 `status: 'skipped', reason: 'busy'`；连续 N 次 busy 可由告警规则自己过滤。
- 跳重叠：作业超时 ≤ 3 h < 4 h 回收阈值，所以陈旧回收**永远不会**回收一条仍在跑的运行；interval ≥ 15 min；长于一跳的运行让下一跳 busy-skip，而不是并行。
- 备料套用：目标表写锁租约（迁移 100）保证跨进程只有一个写者；**已接受**：以可套用主体做的试算会抬高计划代号，使人工未套用的试算令牌失效（`stock-preparation-project-write-lock.cjs:14-20`）——今天的 OS 任务已如此；建议调度在工作时间之外。
- 主失效中途：旧主的在途回调继续跑完（`automation-scheduler.ts:469-483,698-700`），新主下一跳 busy-skip。进程崩溃：`integration_runs` 行留 `running`，4 h 后被回收为 `failed`（`pipelines.cjs:893-927`）；意图行留 `pending`，下次认领翻 `outcome_unknown`（`automation-outbound-intent.ts:117-127`）并由动作层发 `outcome_unknown` 摘要。多实例部署必须开 `ENABLE_SCHEDULER_LEADER_LOCK`（1b 顺带把它登记进 manifest）。

### 3.5 时区

cron 规则有 `timezone`（`automation-triggers.ts:41-44`）且保存校验 IANA（`automation-service.ts:2781-2796`），但缺省是 UTC。含本动作的 cron 规则：编辑器缺省填 `resolveMultitableBusinessTimezone()`（manifest `:674-684`），保存时无时区即 400。DST 由调度器处理（`automation-scheduler.ts:279-280`）。

### 3.6 套用模式

`dry_run_only`（缺省）：只试算、只产生摘要事件（「有变化」当提醒，apply 由人按——沿用 `project-subtree-bridge-design-20260905.md` §2.2 与 runbook 的第一波建议）。`apply_when_ready`：写客户表 = 章程 O ②，需 `INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED === 'true'` **且** owner 对该部署逐项批准（§12 OQ2）；生产策略、沙箱默认、写锁、令牌比对全部沿用。

## 4. Bridge 2：触发器 `integration.run_finished`

### 4.1 事件（闭合键集、values-free）

```
{ eventId, occurredAt, job: { kind, pipelineId? | actionId, projectNo? }, runId?, status ∈ {succeeded, partial, failed, skipped, not_started, outcome_unknown},
  counts: { read, cleaned, written, failed }, durationMs, triggeredBy ∈ {automation, api, manual, replay}, errorClass?, reason?, _automationDepth }
```

没有 `errorSummary` 文本（runner 的 `error.message` 可能带 SQL 片段或值），只有有界的 `errorClass`；没有行、没有字段值、没有连接信息。`projectNo` 是配置标识（脚本 `:535-537` 的同一口径），不是行值。**每次运行恰好一条**；1000 行的拉取 = 1 条事件，不是 1000 条（`pipeline-runner.cjs:1000-1160` 的逐行循环不发任何事件，1c 以计数断言钉死）。

### 4.2 产生与派发

- 插件在 `finishRun` 成功返回后调用 `integrationRunEvents.publish(summary)`（HTTP、自动化、回放发起的运行一律发；开关关即不调用）。动作层对未产生 `runId` 的终态自己补发（§2 ⑤）。
- core 校验闭合键集 → `_automationDepth` 取自发起它的自动化执行（HTTP 发起的为 0）→ 按 `job` 键查启用的 `integration.run_finished` 规则 → 每条规则 `runWithEventDedup(rule.id, 'integration.run_finished:<eventId>')` → `executeRule`，record-less 载荷（与 `automation-service.ts:4100-4116` 同形）。深度 ≥ 3 即丢弃并 warn（`:143`）：「运行完成 → 规则 → 再运行 → 再完成」最多走三层。
- 触发器配置 `{ job: { kind, pipelineId? | actionId }, statuses: [...] }`，缺省 `['failed','partial','outcome_unknown','not_started']`；创建者须持 `integration:read` 及以上或 `stock-prep:read`，并在触发时实时复核（与 `approval.completed` 的 `:4093-4097` 同形）；不满足即跳过并 warn。
- 耐久模式：`AUTOMATION_DURABLE_DELIVERY_ENABLED` 开时，新事件族必须进路由清单 v4（新版本，不改 v1–v3，`automation-routing-manifest.ts:80,99`），1c 一并交；清单里没有该族时 publish 失败关闭并记一行 values-free 日志。**已接受**：事件不与运行行同事务提交（插件用自己的 db 门面），`finishRun` 与 `publish` 之间崩溃会丢一条告警，下一跳的运行会再产生事件。

### 4.3 告警（1c 的规则模板）

触发器 `integration.run_finished{statuses: failed, partial, outcome_unknown, not_started}` → `send_dingtalk_group_message{destinationIds, titleTemplate, bodyTemplate}`；模板变量只有 `run.status / run.counts.* / run.job.* / run.durationMs / run.errorClass`（扩展 `automation-executor.ts:1186-1191` 的 `templateData`，仍经 `renderAutomationTemplate`）。群目标仍按 (sheet, 创建者) 绑定（`:6029`）；群消息失败时既有的「通知规则创建者」路径（`:2906-2925`）照常。告警风暴上限 = 每次运行 1 条 × 每跳作业数（≤ 20 个项目）× 调度频率（interval ≥ 15 min）；不做跨跳抑制（§10）。

## 5. 重试与幂等分类

| 类 | 既有定义 | 本动作的映射 |
|---|---|---|
| class-A（同事务记录写） | `create/update/delete/lock_record`（`automation-retry-eligibility.ts:18-23`），同事务认领（`automation-action-idempotency.ts:89-113`） | **不是**。作业的写入在插件事务里、不在 core 事务里，core 无法同事务认领 |
| class-B（一次性外发） | 五种 `send_*`（`:25-31`），两阶段意图 + `outcome_unknown`（`automation-outbound-intent.ts`） | **借台账不借分类**：意图行 `(kind='execution', rootExecutionId, actionKey)` 复用同一张 `meta_automation_outbound_intent`（不受 `AUTOMATION_CLASSB_OUTBOUND_ENABLED` 开关控制——本动作永远写意图行），但结果分类按下表 |
| **class-C（外部作业，新）** | — | 结果 = 作业终态；可重试性取决于**写入段是否开始**与**目标是否幂等** |

分类规则（代码为准，取代提案里的 append/upsert 措辞）：

- `failureStage ∈ {authorize, load, read, transform}`（源不可达、超时、连接拒绝、变换失败）→ `failed`，**可重试**：动作层按 `retry` 有界重试（≤3、≥60 s 退避），每次重试都重新走 §3.2 全序（含实时复核与 Tx A 的 `retry_failed` 翻转）。runner 不加循环，只在抛出的 `PipelineRunnerError` 上带 values-free 的 `failureStage` 与 `errorClass`（1b 的唯一 runner 改动）。
- `failureStage = write` 且目标为幂等 upsert（`metasheet:multitable`、`data-source:sql-write-gated`，键由字段映射决定）→ `failed`，可重试一次（同键重放只会 upsert 同一行）。
- `failureStage = write` 且目标为非幂等种类（`isGenericHttpWriteKind`，`pipeline-runner.cjs:931-944`），或 `finishRun` 失败（`:1190-1197`）、超时、进程崩溃 → `outcome_unknown`，**永不自动重试**；人工 `retryExecution` 命中意图行的 `skip_unknown` 也不会重跑。
- `stock_prep_pull`：试算幂等 → 可重试；套用一旦消费令牌（`stock-preparation-table-actions.cjs:3228`）即视为写入段开始 → 之后任何歧义 = `outcome_unknown`。
- 行级数据错误：留在死信（`dead-letter.cjs`）与 `partial` 状态，动作**不**重试 `partial`；回放仍只经受治理 HTTP 路由，端口不暴露。
- 真发测试（`realFireTestRunEligibility`）：新动作在 1b 保持 `TEST_RUN_ACTION_UNSUPPORTED`（`automation-retry-eligibility.ts:76-78`）——测试运行不该拉真实 PLM。

## 6. 授权与运行身份

### 6.1 谁能建这样的规则

同时满足：① 对规则所在表 `canManageAutomation`（`sheet-capabilities.ts:106-111`）；② 对作业持运行权——`stock_prep_pull` 要 `stock-prep:pull`（S0 的地板，`http-routes.cjs:1453`）或 legacy `integration:write/admin`、`pipeline` 要 `integration:write/admin`（`:1339-1355`）；③ 主体**带租户声明**（无租户平台管理员保存即 400，与脚本 `:32-50` 的拒绝同理）；④ 当 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 开着时租户须为已验证声明（`:1668-1671`）。

### 6.2 主体绑定

保存时服务端把 `{ principalId: created_by, tenantId }` 盖进 `action_config.binding`，客户端送来的同名键丢弃（`external-systems.cjs:480-482` 的做法）。触发时：主体在役、仍满足 §6.1 ②③、租户相等，三者任一不成立 → `skipped(principal_unauthorized)` + 摘要事件；不回退到任何其它身份。改规则的人**不**接管绑定：`created_by` 不变则绑定不变；要换主体须删除重建（与 `approval.completed` 用 `rule.created_by` 复核的既有口径一致，`automation-service.ts:4093-4097`）。

### 6.3 数据面身份与 owner 停用

读身份不变：`stock_prep_pull` 用服务端盖章的绑定 owner（`http-routes.cjs:6472-6485`），`pipeline` 用 `pipeline.createdBy`（`pipeline-runner.cjs:414-431`），`runAs:'user'` 由受治理入口盖、端口不能自盖（`index.cjs:270` 的同一道理）。宿主数据源门只比 owner 相等（`DataSourceManager.ts:789-799`），所以**绑定 owner 被停用今天不会停下 HTTP 拉取，也不会停下本动作**；是否改为「owner 不在役即拒」交 owner（§12 OQ4）。

### 6.4 租户作用域

动作没有请求、没有请求头，租户只来自保存时冻结的绑定；`x-tenant-id` 请求头在这条路径上不存在，无租户令牌被保存时拒绝——两类历史洞（`x-tenant-id-header-hole`、无租户平台管理员走请求参数）在自动化路径上从源头关闭。规则表没有 tenant_id 列（§1.1），所以 1b **不**给规则表加列：租户落在动作配置的服务端盖章里，并在触发时与表所属 base 的租户比对。

## 7. 开关与上线

| 开关 | 读取点 | 语义 | danger |
|---|---|---|---|
| `INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED` | core 保存校验 + 执行器每次触发 | 关：含 `run_integration_job` 的规则保存 403 `RUN_ACTION_DISABLED`，既有规则触发记 `skipped(action_disabled)` | high |
| `INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED` | 插件 `publish` 前 + core 接收时 | 关：不发、不收；触发器规则可以保存但永不触发 | medium |
| `INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED` | 动作在试算得到 `ready` 之后、消费令牌之前 | 关：`apply_when_ready` 退化为 `dry_run_only` 并在摘要里记 `reason: 'apply_disabled'` | high（打开 = O ②） |

- 全部 `type: 'boolean'`、`activationValue: 'true'`、不修剪不折大小写、`dependsOn: []`、`conflictsWith: []`，登记在 `scripts/ops/global-history-flag-manifest.mjs` 的 `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED` 之后（格式 `:25-48`，范例 `:51-72`）。清单测试只从源码自动推导 `MULTITABLE_*`（`global-history-flag-manifest.test.mjs:388-392`），所以 1b/1c 要像 `:449-475` 那样为每个新开关写显式读取点测试；顺带登记 `ENABLE_SCHEDULER_LEADER_LOCK`（既有、未登记）。
- 与 `AUTOMATION_DURABLE_DELIVERY_ENABLED`：Bridge 1 不受影响（定时执行不是事件）；Bridge 2 在该开关开着时要求路由清单 v4 存在，否则 publish 失败关闭（§4.2）。与 `AUTOMATION_CLASSB_OUTBOUND_ENABLED`：无依赖，本动作的意图行不受它控制（§5）。与 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED`：§6.1 ④。
- 开关切换 = 后端重启 / 重建（pm2 单 fork 启动时读一次 `docker/app.env`，`ecosystem.config.cjs:52,60-61`）。
- 梯子（每级 owner 另批，上一级不自动成立下一级）：L0 合并休眠代码（三开关未设）→ L1 上机、开关仍不设 → L2 开 Bridge 1 + Bridge 2，建一条只试算的规则与一条告警规则，告警群先用测试群 → L3 停用 OS 任务（§8）→ L4（可选）开 `…_APPLY_ENABLED` 并把规则改为 `apply_when_ready`（O ②）。

## 8. 222 切换与回退

- **切换前置**：L2 的规则至少跑过 3 个自然日且摘要事件与脚本日志一致（计数相等、状态相等）；告警规则对一次人为制造的失败（例如把规则指向一个已归档项目）发出过一条消息（见证红）。
- **切换**（L3，O ④）：`schtasks /Change /TN "MetaSheet-StockPrep-ScheduledPull" /DISABLE`（任务名以 runbook `:904-912` 登记的为准），**不删除**任务与令牌文件；同一天观察自动化规则的那一跳。
- **回退** = 把 `INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED` 置回未设并重启，再 `schtasks /Change … /ENABLE`。两步都不碰数据：规则留在表里（触发时记 `skipped(action_disabled)`），`integration_runs` 与审计行只增不改。回退不需要迁移回滚：1b/1c 的迁移只放宽 CHECK 与词表，旧代码不会写出新值。
- **令牌**：切换完成并稳定一周后，由客户运维按自己的轮换纪律撤销服务账号令牌（runbook `:926-928` 把保管与轮换定为客户运维职责，本仓库不含任何默认值）；此前保留以便回退。
- **不切换的情况**：若 owner 不批 L2 的任何一步，OS 任务原样保留，本 ADR 的代码在部署上保持休眠。

## 9. 可观测与 values-free

- 自动化执行行：`triggered_by='schedule'`（或触发它的事件）、规则 id、步结果 `{ status, output: { runId, status, counts, failureStage, errorClass } }`；不含行值、连接、错误正文。
- `integration_runs` 行：`triggered_by='automation'`、`details.automation = { ruleId, executionId, triggerType }`，其余与 HTTP 发起的运行同形；`details` 不新增任何值面字段。
- 备料审计行（`stock-preparation-audit-store.cjs`）：actor = 绑定主体 id，新增 `source: 'automation'` 与 `ruleId`；「谁要求的」（绑定主体）与「用谁的凭据读的」（绑定 owner）继续是两个事实（`http-routes.cjs:6438-6443` 的既有口径）。
- 日志：动作与端口的所有 Logger 调用只带 `ruleId / executionId / runId / status / errorClass`；主体 id 与租户 id 不进日志行。
- 摘要事件按 §4.1 闭合；测试用计数断言「1000 行 ⇒ 1 条事件」。
- 证据面（issue / PR / 登记册）：只记状态与计数，不记项目号以外的任何配置值；项目号属配置标识，与脚本输出的口径一致。

## 10. 不在本 ADR 范围内

- 可视化流程画布、第三台编排引擎、用户自定义连接器种类、连接器市场。
- 逐行事件、`record.created` 对插件路径写的补发。
- 自动化经跨插件通信 API 或自调 HTTP 发起写入；端口暴露 `replayDeadLetter`。
- 无人值守宜搭发送（阶段 2 的「发送草稿」动作要在客户机上有一次真实宜搭发送之后另立 ADR，仍受 R-50 发送开关与逐条批准约束）。
- 接活或删除 `integration_schedules`、`data_sync_jobs`、`external_tables` 死表（另案）。
- 入站 webhook 触发管道（Bridge 2 是出站摘要；入站已有 `webhook.received`，是否绑到作业待第二个场景）。
- 跨跳告警抑制（「连续失败只报一次」）、运行时长趋势、仪表盘。
- 试算令牌记录的清扫器（runbook `:930-933` 已记的既有缺口；按日调度量级可忽略）。
- 把 `errorSummary` 分类细化成更多 `errorClass`；连接器选择器、通用宜搭映射、宜搭入站事件（阶段 3，只在第二个客户或场景提出时做）。

## 11. 切片、测试与变异见证

- **PR 0（1a）**：本 ADR + 登记册 R-69（PROPOSED）。
- **PR 1b（动作）**：core：`automation-actions.ts` 联合类型与配置形状、保存校验（§3.1、§6.1）、执行器 `run_integration_job`（§3.2、§5）、端口登记与解绑（`index.ts` 的 `registerPlugin…` 同形 + `cleanupPluginRuntimeRegistrations`）、动作 CHECK 迁移、开关清单与显式读取点测试、`ENABLE_SCHEDULER_LEADER_LOCK` 登记、前端规则编辑器的动作项与时区缺省。插件：req-less 受治理入口抽取（§2 ③；HTTP 路由改为调用它、行为逐字节不变——以既有路由测试钉住）、端口实现、`VALID_TRIGGERS` 增 `'automation'`、runner 错误带 `failureStage/errorClass`、s6a 来源 pin 重算。
- **PR 1c（触发器 + 告警模板）**：触发器类型与 CHECK 迁移、事件闭合校验、按作业路由与去重、路由清单 v4、`publish` 端口、模板变量、规则模板（告警群 + 文案）、前端触发器项。
- **真库用例（EXPECT_DB 车道，三处镜像 `plugin-tests.yml` / 文件清单 / `vitest.config.ts` 排除）**：一管道一在途（并发两次端口调用恰一次运行、另一次 `skipped(busy)`）；意图行崩溃窗口（Tx A 后杀进程 → 下次 `outcome_unknown`、零第二次运行）；陈旧回收不碰在途运行；写锁租约下的套用互斥；CHECK 迁移 up/down。
- **变异见证（每条守卫先见红再报绿）**：开关读取点改成 `!== 'true'` 必红；去掉触发时实时复核必红（撤权后仍跑）；端口缺席时回退到 `communication.call` 必红；端口自盖 `runAs:'user'` 或 `C6_WRITE_LIFECYCLE_CONTEXT` 必红（armed 夹具下写入被拒的断言翻转）；保存时接受无租户主体必红；指纹不比对必红；`failureStage=write` + 非幂等目标被重试必红；`intervalMs` 下限与 `timeoutMs` 上限去掉必红；逐行 emit 必红（1000 行夹具事件数 ≠ 1）；深度守卫去掉必红（三层后仍触发）；摘要多一个键必红；`errorSummary` 进事件必红；日志带主体 id 必红。
- **CI 陷阱清单**：test-chain 完整性（插件新测试要登记 `test-chain.txt`）、s6a `pluginIndex` 重 pin、EXPECT_DB 三处镜像、guarded-paths 与 `integration-guard.yml` 集合相等、开关清单源码推导与显式测试、`index.ts` this-census 冻结字面量（新增 `this.X` 必跑完整 core-backend 单元套件）、web spec 变异锚点唯一性、`EXPECTED_OPS_TESTS_COUNT`（若动 `scripts/ops/__tests__`）。

## 12. 待 owner 裁定

1. **OQ1 范围**：动作覆盖「备料拉取（表动作）」与「数据管道」两种作业、1b 先交拉取；接受本 ADR 对已批提案措辞「运行数据管道」的修正（Q1）。
2. **OQ2 无人值守套用**：是否进入计划；若进入，`INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED` 的打开与每条 `apply_when_ready` 规则为 O ② 逐项批准（Q12）。
3. **OQ3 222 切换**：L1 上机、L2 开开关与建规则、L3 停用 OS 任务、令牌撤销时点（§7 梯子、§8；O ④）。
4. **OQ4 绑定 owner 停用**：是否要求绑定数据源的 owner 在役，否则拒跑（今天不拒，Q14）。
5. **OQ5 告警目的地**：首个真实钉钉群与接收人（真实发送 = O ④）；测试群阶段用合成失败见证。
6. **T 层默认、24h 可否决**：三个开关名、重试 ≤3/≥60 s、interval ≥ 15 min、timeout ≤ 3 h、`'automation'` 词项、指纹键集、事件缺省状态集、告警不做跨跳抑制。
7. **R-69 登记行**（PROPOSED → RULED 由 owner 一并裁定）。

## 附录：借鉴而不引入外部引擎

owner 2026-11-03 问「能直接借鉴 n8n 的框架底座么」。裁决：**借鉴设计思路，不嵌入 n8n 或任何外部编排引擎**（T 层默认），理由三条：

1. **许可**：n8n 采用 Sustainable Use License，允许内部业务使用；把它嵌进交付给客户的产品需要另签 n8n Embed 商业协议（见 docs.n8n.io 的 sustainable-use-license 页）。接管线的交付物是装在客户机上的产品，这一条就足以排除。
2. **围栏**：n8n 的节点模型里任何 HTTP 节点或 Code 节点都能直接出网、直接写，等于绕过本仓库的三道红线——外部写默认 OFF 且只认原文 `true`、K3 写回永久禁止、宜搭逐条批准发送。要在 n8n 里重建这些围栏，工作量不小于本 ADR，而且围栏会落在我们不拥有的代码里。
3. **运行形态**：n8n 是一个独立应用，自带数据库、用户体系、凭据加密密钥与队列；客户机是 Windows + pm2 单 fork 的本地部署（`ecosystem.config.cjs:60-61`），多一个常驻服务就多一套备份、升级、账号与密钥的运维面。

借用的只是思路（不复制代码或文本）：

- **连接器 = 凭据类型 + 操作清单 + 参数 schema 的声明**：对应本仓库闭合的连接器种类登记表（`gip-connector-kind-registry.cjs`），仍不允许用户自定义种类。
- **凭据与流程分离**：对应连接收敛到 `data_sources` 与服务端盖章的 `dataSourceOwnerId`，流程（规则）里只有引用。
- **按步重试次数 / 间隔 + 错误流钩子**：对应 §5 的有界重试与 Bridge 2 的失败触发器。
- **固定样本数据做试运行**：对应既有的静态预演与 `dryRun` 试算。
- **按步执行历史**：对应自动化执行行的步结果与 `integration_runs` 行。
