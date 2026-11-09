# 自动化 × 数据管道：用「运行集成作业」动作与「作业运行完成」触发器把两台引擎连起来，替换 OS 定时任务并补失败告警（ADR 2026-11-03）

> **状态**：草稿 v4。v3 并入独立评审第一轮 FIX_FIRST 的 F1–F10、N1–N3，与第二轮 READY 的 NF1–NF6；v4（2026-11-06）按冻结设计基线 v2.3 §10.2.6（`ipaas-yida-dev-baseline-v2.3-20261106.md`）修订旧任务的说法、作业超时、作业租约与切换前置，改动见文末「附注：2026-11-06 修订」M1–M5，正文受影响处标「11-06 注 Mx」。owner 2026-11-03 对主会话「两台引擎保持独立、只做连接、不建第三台」的提案回复「批准写 1a 的 ADR」；本 ADR 即 1a。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决；标「待 owner 裁定」的条目在 §12 汇总，未裁定前不开 1b。**任何无人值守的写入（备料套用、非试算管道运行）都不在 T 层默认之内，各自有默认关的开关并路由给 owner。**
> **线别**：备料接管线的交付项（「替换 OS 定时任务 + 失败告警」），比照 R-50 对 #6315 的框定，不算第三条线；本 ADR 不解封 #6323 / #6324 / #6337。
> **基线**：main `b36f53c2f`（`b36f53c2f9140237f1cebfb162923c3181f6d9fb`）。下文所有 `path:line` 都在这个提交上核过；新增文件只写路径不写行号。初稿冻结在 `8f3867da7`，2026-11-04 合并 main 后逐条重核、重冻结到本提交；其间 main 改变了本 ADR 依赖的若干事实，见文末「附注：2026-11-04 重冻结」N1–N5，正文结论未改写、受影响处以「11-04 注 Nx」标出。合并前若 main 再前进，按章程重核行号。
> **values-free**：不含主机、地址、口令、令牌、租户名、账号名或任何客户值，只指位置；「222」只是客户测试机在本目录文档里的既有代号；任务计划程序里的任务名也不写死，只指到读取它的位置。
> **关联**：R-42（两条线）、R-50（框定范式）、R-69（本 ADR 的登记行，OPEN）；`docs/integration-consolidation-plan-20260901.md` §4 动作三与 `:4` 的勘误；`docs/integration-consolidation-minimal-plan-20260901.md` §6.1（`run_integration_pipeline` 动作与 `IntegrationRunPort`）；`project-subtree-bridge-design-20260905.md` §2（定时拉取为什么落在 OS）；`222-deploy-window-runbook-20260901.md` 「定时拉取」节；`adr-yida-connection-test-20261028.md`（宿主私有运行时 / 插件能力的分工范式）。
> **来源**：客户的备料拉取今天由 OS 任务计划程序运行 `scripts/ops/stock-preparation-scheduled-pull.mjs` 经 HTTP 发起，失败无人知道。主会话读码后建议：两台引擎（multitable automation、data-factory pipeline）保持独立、用两座桥连接；owner 2026-11-03 批准先写 ADR。owner 同日追问「能直接借鉴 n8n 的框架底座么」，答复见附录。

**裁决记录**

| # | 问题 | 裁决 | 层 | 落在哪里 |
|---|---|---|---|---|
| Q1 | OS 任务跑的到底是什么 | **不是管道**：脚本打的是备料表动作 `dry-run → apply`（`stock-preparation-scheduled-pull.mjs:377-381`）；**带 `--apply` 时才套用，222 登记的任务不带**，按仓库记录只试算，现状待现场计数（11-06 注 M1），`pipelines/:id/run` 从未被它调用。所以 Bridge 1 的动作是「运行集成作业」`run_integration_job`，作业种类闭集 `{stock_prep_pull, pipeline}`；1b 先交 `stock_prep_pull`（这才替换得了 OS 任务）；`pipeline` 种类在 1b/1c **只允许试算**（Q12b） | 待 owner 裁定（偏离已批提案的措辞，§12 OQ1） | §1.5、§3 |
| Q2 | 动作落在 core 还是插件 | core 执行器持有动作类型、校验、幂等台账与审计；插件在激活时向 core **登记**一个 `IntegrationRunPort`（插件→core 的端口，与 `workdayCalendar.register` 同形，`index.ts:1772-1782,2818-2820`），只对 `plugin-integration-core` 开放；端口缺席即失败关闭。不走 `communication.call`，不自调 HTTP。端口的主体上下文由 core 从实时 RBAC 构造（§6.4） | T 层默认 | §2 ②③、§3.2、§6.4 |
| Q3 | 运行身份绑定给谁 | 授权主体 = 规则的 `created_by`，**保存时冻结**、每次触发**实时复核**；推荐生产规则由租户绑定的服务账号令牌经自动化 API 创建（与 runbook / 运行记录里的服务账号一致），编辑器建的规则绑的是那个人、此人停用即停拉并告警；数据面读身份保持服务端 `dataSourceOwnerId`（`http-routes.cjs:6472-6485`）与 `pipeline.createdBy`，不随规则变；无租户声明的主体保存即拒 | T 层默认（生产规则用哪个身份 = §12 OQ7） | §6 |
| Q4 | 重试 | 只在写入段**之前**失败（授权/加载/读源/变换，以及授权读取本身不可用）才由动作层有界重试（≤3 次、≥60 s 间隔）；写入段已开始且目标非幂等即 `outcome_unknown`、永不自动重试；消费令牌之后的 409（修订不符 / 不可套用）是**确定的拒绝**，记 `skipped(stale_plan)`、不重试、不算 unknown；行级数据错误留在既有死信。runner 本身不加重试循环 | T 层默认 | §5 |
| Q5 | 同一作业同时只跑一次 | **管道**已有 DB 级围栏：`uniq_integration_runs_one_running_per_pipeline`（`058_integration_runs_running_unique.sql:34-36`）+ 应用层 409（`pipelines.cjs:34,730-734`），主会话「没有锁」的线索不成立；**备料拉取没有**（表动作不写 `integration_runs`，调度器也没有按规则的在途互斥 `automation-scheduler.ts:490-504`）。所以 1b-ii 新增 core 侧短租约 `meta_automation_job_leases`，键 `stock_prep_pull:<tenantId>:<projectNo>`（管道种类也加 `pipeline:<pipelineId>` 作纵深）；第二个持有者记 `skipped(busy)`；租约**只以 fence-CAS 释放、永不删行**，fence 单调，超时的僵尸持有者释放不了后继者的租约；`timeoutMs` 作为 AbortSignal 传入端口并由受治理入口检查；`stock_prep_pull` 只接受 `schedule.cron`；作业超时必须小于 4 h 的陈旧回收阈值（`pipelines.cjs:898`） | T 层默认 | §3.4、§11 |
| Q6 | Bridge 2 事件形状 | 新触发器 `integration.run_finished`：**每个作业（每个项目）恰好一条** values-free 摘要（状态 + read/cleaned/written/failed 计数 + 时长 + 错误类别），只在动作步的**最终**尝试之后发，中间可重试的失败只进步输出；没有逐行事件；自动化发起的运行由动作层发、插件不再重复发；eventId 确定性派生。状态集 `{succeeded, partial, failed, held, skipped, not_started, outcome_unknown}`：`held` = 人工待办（`manual_confirm_required` 等），**缺省不告警**；`skipped` = 系统侧跳过（撤权、busy 等），缺省告警。按作业 id 路由的专用派发路径（与 `approval.completed` 同形），不进 `TRIGGER_TYPE_BY_EVENT` | T 层默认 | §4 |
| Q7 | 告警 | 复用 `send_dingtalk_group_message` / `send_dingtalk_person_message`，1c 只交一个规则模板，不建告警系统 | T 层默认（真实群 = O ④，§12 OQ5） | §4.3 |
| Q8 | 开关 | 四个新 env 开关，默认关、只认原文 `true`、登记 flag manifest：`INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED`（Bridge 1，试算类作业）、`INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED`（Bridge 2）、`INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED`（无人值守备料套用，O ②）、`INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED`（无人值守非试算管道运行，O ②/③）。后两个开关的打开永远是 owner 决定，1b/1c 不交它们控制的代码路径 | T 层默认（后两个开关的打开 = O 层） | §7 |
| Q9 | 时区 | 含本动作的 cron 规则**必须带** IANA 时区，缺省填业务时区（`MULTITABLE_BUSINESS_TIMEZONE`，默认 Asia/Shanghai）；不带时区即保存拒绝（今天缺省是 UTC，`automation-scheduler.ts:196-205`） | T 层默认 | §3.5 |
| Q10 | 审计记谁 | 自动化执行行记 `triggered_by='schedule'` + 规则 + 创建者；`integration_runs` 新增 `triggered_by='automation'` 词项，`details.automation = {ruleId, executionId, triggerType}` 只放标识；备料审计行的 actor = 绑定主体，另加 `source: 'automation'` | T 层默认 | §9 |
| Q11 | 管道 / 项目在规则创建后变了 | 保存时冻结管道指纹（源/目标系统 id、对象、模式、映射的 sha256，与 FWB `confirmationHash` 同形 `automation-actions.ts:78-85`）；触发时不符即 `skipped(pipeline_changed)` 并发 Bridge 2 事件；项目不存在 / 已归档沿用脚本语义记 `skipped` | T 层默认 | §3.3 |
| Q12a | 无人值守备料套用（apply） | 不在 1b/1c：`applyMode` 只接受 `dry_run_only`，`apply_when_ready` 保存**一律** 400、与开关无关。它是写客户表的生产写入（章程 O ②），后续切片要 `…_RUN_APPLY_ENABLED` + owner 逐部署批准；生产策略仍只认服务端配置（`stock-preparation-production-policy.cjs:5-16`） | 待 owner 裁定（§12 OQ2） | §3.6 |
| Q12b | 无人值守非试算管道运行 | **不在 1b/1c**：`pipeline` 种类 `dryRun` 固定为 `true`，保存时拒绝 `dryRun:false`。原因：休眠部署上 `assertPipelineRunAllowed` 直接返回（`http-routes.cjs:6320`），`metasheet:multitable` 目标会在 C6 生命周期之外被写（O ②）；被 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` 列入的 HTTP 目标会「正常写出」（`pipeline-runner.cjs:483-500`，O ③）。非试算运行留给后续切片，受 `…_RUN_PIPELINE_WRITE_ENABLED` + owner 裁定 | 待 owner 裁定（§12 OQ6） | §3.2、§7 |
| Q13 | 调度主失效 / 进程中途崩溃 | 主失效只清计时器不中止在途回调（`automation-scheduler.ts:469-483`），新主再触发撞租约 / DB 围栏即 `skipped(busy)`；崩溃留下的 `pending` 意图行在下次认领时翻成 `outcome_unknown`（`automation-outbound-intent.ts:237-246`；11-04 注 N1：#6715 起要等该行租约过期才翻，租约内认领得 `skip_inflight`），由动作层以 `outcome_unknown` 摘要事件告警；按作业种类分述见 §3.4 | T 层默认 | §3.4、§4.2 |
| Q14 | 绑定数据源的 owner 被停用 | 今天宿主只比 owner 相等、不查在役（`DataSourceManager.ts:791-801`），HTTP 路径亦然；本 ADR 只实时复核**授权主体**的在役与权限，绑定 owner 停用是否应停拉取交 owner | 待 owner 裁定（§12 OQ4） | §6.3 |

---

## 0. 为什么

1. **失败无人知道。** OS 任务只把一行 JSON 写进脚本自己的日志，产品内没有记录「这次定时拉取本身」的审计动作，失败次数与原因只能去日志文件或任务计划程序的历史里查（`222-deploy-window-runbook-20260901.md:930-937`）。
2. **调度能力在 core 里已经有了，缺的是把作业接上去。** 平台有 cron / interval / date_field 调度器 + 可选 Redis 主选举（`automation-scheduler.ts:1-6,44-58`），但动作类型表里没有「跑一个集成作业」（`automation-actions.ts:6-33`）——这正是脚本头注释 (2) 与 `project-subtree-bridge-design-20260905.md:80` 当时放弃进程内调度的原因；补这一项是 core 改动，不是运维脚本。
3. **插件侧也没有调度器。** 作为代码字面量，`'cron'` 在整个插件里只出现在词表 `pipelines.cjs:30`（另两处是散文注释：`stock-preparation-project-board.cjs:191`、`stock-preparation-pull-target-scan.cjs:506`），没有任何代码产出 `triggeredBy: 'cron'`（runner 缺省 `'manual'` `pipeline-runner.cjs:918`，所有路由盖 `'api'` `http-routes.cjs:7598,7632`）；`integration_schedules` 表（`057_create_integration_core_tables.sql:165-177`）建了却没有任何写入方或读取方。两份收敛方案都已裁定不接活它（`integration-consolidation-plan-20260901.md:4`，`integration-consolidation-minimal-plan-20260901.md:284`）。
4. **不建第三台引擎。** 两台引擎各自的安全性质（自动化的两阶段意图/`outcome_unknown`/事件去重；数据工厂的 B2a 读围栏、C6 写生命周期、K3 永久禁写、死信）都是花过代价才有的，连接比重建便宜，也不引入新的授权面。

## 1. 现状与约束（读码结论）

### 1.1 自动化引擎

- **动作与触发器闭集**：动作 16 种（`automation-actions.ts:6-33`，`ALL_ACTION_TYPES :35-52`）；触发器 11 种（`automation-triggers.ts:6-17`）。记录事件经 `TRIGGER_TYPE_BY_EVENT`（`:87-92`）；`approval.completed` / `approval.task_created` 走按模板 id 路由的专用派发路径，不经该表（`:57-63`；`automation-service.ts:4084-4129`）。新类型要改 DB CHECK：触发器 CHECK 最后一次重建在 `db/migrations/zzzz20260705140000_add_approval_task_created_trigger_type.ts:14-27`，动作 CHECK 在 `zzzz20260720120000_add_write_approval_form_values_automation_action.ts:28-34`——1b-ii、1c 各带一支迁移。
- **调度器**：cron 五段式、UTC 分钟分辨率（`automation-scheduler.ts:151-163`），可带 IANA 时区（`:171-183`，缺省/非法回落 UTC `:196-205`，保存时校验 `automation-service.ts:2785-2800`）；下一次出现用逐分钟扫描（`:252-287`）；触发后从「现在」重排、不补发（at-most-once，`:527-534`）；interval 用 `setInterval`（`:614`）。**没有按规则的在途互斥**：`runScheduledRule` 只把回调放进 `inFlight` 供停机排空（`:490-504`），下一跳到了就再触发一次。主选举是可选项：`ENABLE_SCHEDULER_LEADER_LOCK === 'true'` 且 Redis 可用才建锁（`automation-service.ts:1402-1412`）；没有锁即永远当主（`automation-scheduler.ts:383-388`）；失主只清计时器（`:469-483`），不中止在途回调。该开关在初稿基线 `8f3867da7` 的 flag manifest 里**未登记**；11-04 注 N2：#6716 已登记它（`scripts/ops/global-history-flag-manifest.mjs:930-940`）。
- **定时回调**：先查表是否在役，再 `executeRule(rule, { _triggeredBy: 'schedule' })`（`automation-service.ts:1504-1531`，在役检查 `:1517-1522`）——record-less、无 actorId；执行上下文携带 `ruleCreatedBy` 与可空 `actorId`（`automation-executor.ts:1565-1573`）；跨库写门按规则创建者裁（`:4404`）；钉钉群目标按 (sheet, 创建者) 绑定（`:6408`）。执行行落 `triggered_by`（`automation-log-service.ts:39,83`，列缺省 `'event'`，`zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts:23`）。
- **规则表**：`automation_rules(sheet_id, trigger_type, trigger_config, action_type, action_config, actions, created_by …)`（`zzzz20260413120000_create_automation_rules.ts:24-37`，`zzzz20260414100000_extend_automation_rules.ts:24-27`），**没有 tenant_id 列**；规则只挂在表上。创建规则的门是该表的 `canManageAutomation`（`routes/univer-meta.ts:22009,22019`），= 平台管理员或 `workflow:*` 权限（`sheet-capabilities.ts:106-111`）；`createdBy` 取自认证用户（`univer-meta.ts:22026`，落库 `automation-service.ts:1775`）。请求上的 `user.permissions` 是每次请求按用户行 + RBAC 解析出来的档案（`auth/AuthService.ts:591,599`，`resolveRbacProfile :746`）。
- **外发两阶段**：意图行先提交（Tx A）→ 一次尝试 → 结果行（Tx B，`WHERE status='pending'` 单写者）；`pending` 残留在下次认领时翻成 `outcome_unknown`、永不自动重发（`automation-outbound-intent.ts:298-332,342-365`）；分类：2xx=sent、DNS/拒连/TLS=failed（可重试）、其余=unknown（`:430-439`）；开关 `AUTOMATION_CLASSB_OUTBOUND_ENABLED === 'true'`（`:118-120`）。`send_webhook` 的用法在 `automation-executor.ts:4990-5097`。11-04 注 N1/N3：#6715 给意图行加了尝试令牌、租约与 `target_key`，`skip_unknown` 改为停下后续步骤；#5619/#5649 给 `send_webhook` 加了发送时目标检查。
- **幂等键**：`deriveActionKey` = JSON 数组编码的 (结构路径, 动作类型, sha256(规范化配置)[:16])（`automation-action-idempotency.ts:58-64`）；class-A 同事务认领（`:89-113`）；`classifyOutboundOutcome`（`:133-140`）。
- **重试资格**：class-A = 四种记录写，class-B = 五种外发（`automation-retry-eligibility.ts:18-31`）；未知动作类型在真发测试里是 `TEST_RUN_ACTION_UNSUPPORTED`（`:76-78`）；重试窗口 7 天（`:144-149`）；台账证据只对 A/B 两族要求（`:167-196`）；`retryExecution` 的拒绝码在 `automation-service.ts:3514-3562`，路由仅管理员（`routes/automation.ts:1091`）。
- **耐久投递**：`AUTOMATION_DURABLE_DELIVERY_ENABLED`（trim + 小写后等于 `true`，`automation-durable-delivery.ts:20-22`，与其它开关的 byte-exact 不同）；开则 outbox 替换（不是并存）旧总线 emit（`automation-producer-emit.ts:1-25`）；事件族由版本化路由清单声明，新族 = 新版本（`automation-routing-manifest.ts:80-92,99,126-136,179-188`）。去重键 `${eventType}:${_eventId}`（`automation-event-dedup.ts:17-26`）；`runWithEventDedup` 在开关关时用一次性认领、开时用租约（`automation-service.ts:2468-2488`；租约原语 `automation-event-fires-lease.ts:26-65`）。递归上限 `MAX_AUTOMATION_DEPTH = 3`（`automation-service.ts:145`）。
- **入站 webhook**：HMAC-SHA256 over `${timestamp}.${body}`、300 s 重放窗、60/分钟限流、统一 401（`automation-inbound-webhook.ts:3-11,52-59,69-99`；路由 `routes/automation.ts:447-464`）。本 ADR 不动它。
- **插件路径的记录写不产生自动化事件**：插件 API 的 `createRecord` 在事务里过写围栏后直接调 `createMultitableRecord`（`index.ts:1306-1326`），`records.ts` 只写修订（`:762` 注释），不 emit；`'multitable.record.created'` 的发射点只有 `record-service.ts:1015,1062,1589,1602`、`automation-executor.ts:4065,4076`、`approval-fwb-write-action.ts:204`。主会话这条线索**成立**。所以「拉取写了多少行」永远到不了 `record.created` 触发器——Bridge 2 必须是摘要事件，不能寄望行事件。

### 1.2 数据工厂（plugin-integration-core）

- **受治理的 HTTP 入口**：`POST /api/integration/pipelines/:id/run`（`http-routes.cjs:58`）先 `requireAccess(req,'write')`（`:7585`；权限梯 `integration:read/write/admin`、`role:admin`，`:1339-1355,1368-1377`），再 `assertPipelineRunAllowed`（`:6318-6340`：**休眠部署直接返回 `null`** `:6320`；armed 部署下对 `metasheet:multitable` 目标的非试算运行答 403 `C6_SAFE_LIFECYCLE_REQUIRED` `:6324-6333`，然后做 B2a 读授权），然后盖 `triggeredBy:'api'`、`runAs:'user'`（`:7598,7599`），**只在这里**附 `C6_WRITE_LIFECYCLE_CONTEXT`（`:7614`）。试算路由同形、不附写标记（`:7618-7638`）。这些检查消费的是请求形上下文：`getUser(req)` → `user.permissions / roles / role / tenantId`（`:1318-1337`）、`req.authenticatedTenantId` 与 `collectExplicitTenantIds(req)`（`:1440-1466`）、`req.query/params`（`:1476-1499`）。
- **runner 级 C6 写围栏**：`assertC6WriteLifecycleContext` 在 `runPipeline` 与 `replayDeadLetter` 的第一行（`pipeline-runner.cjs:658-693,905,1233`）；armed-scoped（`:687`）；非试算且无标记即拒绝。K3 WISE 实写是 C6-only、在 runner 里直接拒（`:452-458`）。通用 HTTP 写目标默认拒、被 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` 列入即「正常写出」（`:483-500`；`outbound-http-write-gate.cjs:6,142`）。
- **跨插件通信 API**：`communication.register('integration-core', …)`（`index.cjs:601-602`）暴露的 `runPipeline` 先剥掉两个服务端专有标记、再强制 `runAs:'service'`（`:178-188,259-271`）——所以 armed 部署下跨插件试算可以、写入被拒；这是正确姿态，本 ADR 保留且不新开第二条绕路。
- **运行身份**：runner 以 `principal: pipeline.createdBy` + `runAs` 解析源/目标连接（`:414-431`）；`'user'` 只在 HTTP 可达的处理器下盖（`http-routes.cjs:7599,7634`，以及注释上绑定管理员 HTTP 处理器的 `sealed-export/stock-preparation-runtime-core.cjs:241`）；连接解析器只在 `runAs === 'user'` 且有主体时走 owner 兼容路径（`connection-resolver.cjs:275,307,395`）。宿主数据源门是**严格 owner 相等**，平台管理员例外（`DataSourceManager.ts:791-801`）。
- **一管道一在途运行**：部分唯一索引（`058_integration_runs_running_unique.sql:34-36`）+ 应用层 409（`pipelines.cjs:34,438-443,730-734`）；每次运行前先回收超过 4 h 的 `running` 行（`:893-926`，缺省常量 `:898`，调用点 `pipeline-runner.cjs:943-955`）。**主会话「没有按管道的锁」不成立；但它只覆盖管道**——备料表动作不写 `integration_runs`（`stock-preparation-table-actions.cjs` 里没有 `integration_runs` / `RUNNING_RUN_UNIQUE_INDEX` 的任何引用）。
- **运行结束**：每次 `runPipeline` 都 `startRun` 一行（`:957-968`）；`rowsFailed > 0` 或翻页到顶 = `partial`，否则 `succeeded`（`:1173`）；`finishRun` 失败只记 `FINISH_RUN_FAILED` 警告、不抛（`:1190-1197`，注释明说是防调用方重试造成重复写）；抛错路径记 `failed`（`:1205-1221`）；水位只在成功后推进（`:1161-1170`；类型 `updated_at | monotonic_id`，`watermark.cjs:6`）。**runner 没有任何重试循环**（`pipeline-runner.cjs:1193,1345` 只是关于调用方重试的注释）。
- **死信**：`open | replayed | discarded`（`dead-letter.cjs:7`），`retryCount`（`:81,165-174`）；回放永远是实写、要 C6 标记（`pipeline-runner.cjs:1227-1233`），非 `open` 或载荷截断即拒（`:1246-1259`）。
- **词表**：`VALID_MODES = {incremental, full, manual}`（`pipelines.cjs:26`）是读模式；`VALID_TRIGGERS = {cron, manual, api, replay}`（`:30`）；`integration_runs.triggered_by` 无 CHECK、只有注释（`057:105`）。

### 1.3 今天的 OS 定时任务（备料拉取）

- 脚本是普通 HTTP 客户端，顺序打 `table-actions/plm.stock-preparation.pull-bom.v1/dry-run` → `…/apply`（`stock-preparation-scheduled-pull.mjs:377-381,540-560`），缺省只试算（`:25-30,147-149`），**带 `--apply` 时才套用；222 登记的任务不带**（11-06 注 M1），输入只来自环境变量（`:70-73,123`）；令牌须为**租户绑定**的服务账号（`:32-50`，否则 `--allow-tenantless` 才放行）。
- 两枪必须同一次运行：试算令牌一次性、30 分钟 TTL（`stock-preparation-table-actions.cjs:169-170,2001`），套用先原子消费令牌再校验（`:2146-2159`：消费后才判过期 / 不符，所以被拒的令牌照样烧掉），再比对修订与可套用性（`:3228,3303-3307`，409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH` / `TABLE_ACTION_DRY_RUN_NOT_APPLYABLE`）。套用默认只允许沙箱目标，生产策略只认服务端配置（`stock-preparation-production-policy.cjs:5-16`）。目标表有跨进程写锁（租约 + 计划代号，`stock-preparation-project-write-lock.cjs:1-45`，迁移 100）；**每个可套用主体做的试算都会抬高计划代号**（`:14-18`），使更早的未套用令牌在套用时以 409 不符收场。
- 表动作的门：`requireTableActionAccess`（`http-routes.cjs:1440-1466`）——持 legacy `integration:*` 即放行并跳过 operator-scope；否则要 PULL 梯（`operatorMayRunStockPrepPull :1453`，梯的定义：`stock-prep:pull ∧ operate ∧ read`，或 `stock-prep:admin`，`:1384`、`stock-preparation-workbench-access.cjs:747`）+ 作用域解析。读身份对这一个 actionId 用服务端盖章的 `config.dataSourceOwnerId`（`http-routes.cjs:6472-6485`；盖章与剥除 `external-systems.cjs:30-34,480-482,515`）。
- **x-tenant-id 历史**：鉴权中间件在令牌无租户声明时把请求头 `x-tenant-id` 填进 `user.tenantId`（`http-routes.cjs:1414-1415,1574,1644` 注释）；`resolveTenantId` 对租户绑定主体强制相等、对无租户平台管理员采信请求（`:1476-1499`；`isTenantlessPlatformAdmin :1362-1366`）；硬门 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED`（`:1764-1766`，`assertVerifiedTenantClaim :1668-1671`）默认关，打开它是部署事件：先填 `user_orgs`、重签令牌、全员重新登录（`:1747-1753`）。脚本头注释与 runbook 都因此要求租户绑定令牌（`222-deploy-window-runbook-20260901.md:852-866`）。
- 222 上已注册每日 06:00、只试算的计划任务，令牌为专用服务账号（登录禁用、按期签发令牌；`48h-autonomous-run-record-20260906.md:32,56`）；runbook 列出的已知限制：试算令牌记录只在被套用时删除、高频试算会累积；产品内无该任务的审计（`222-deploy-window-runbook-20260901.md:930-937`）。
- 部署形态：pm2 单 fork（`ecosystem.config.cjs:60-61`）——今天没有第二个调度器，主选举开关的缺席不构成风险。

### 1.4 与两份收敛方案的关系

- 总方案 §4 动作三曾提议「照 automation-scheduler 模式给 `integration_schedules` 接一条写入方」（`integration-consolidation-plan-20260901.md:112-119`，§7 P2 `:151`），其 `:4` 勘误已改口为「复用 Automation + IntegrationRunPort」。本 ADR 采纳勘误：**不接活 `integration_schedules`**，它留作死表待另案删除。
- 最小方案 §6.1 提议动作 `run_integration_pipeline`、宿主 `IntegrationRunPort.request()`、持久化 `integration_run_requests`、独立 Worker、至少一次队列（键 `triggerId + scheduledFor`）（`integration-consolidation-minimal-plan-20260901.md:282-298`）。本 ADR 保留「宿主端口 + 触发器不授予外部写权 + 不可经 HTTP/自 webhook 绕围栏」三条，**去掉**独立 Worker、请求表与至少一次队列：自动化执行器就是 worker，`integration_runs` 行 + 唯一索引（管道）与新租约（备料）就是去重，调度语义沿用调度器的 at-most-once（今天的 OS 任务同样是每日一次、不补发）。动作名改为 `run_integration_job`，原因见 Q1。

### 1.5 主会话线索与代码的四处不一致（代码为准）

1. **「替换 OS 任务 = 给管道一个调度」**：OS 任务跑的是备料表动作，不是管道（§1.3）。只做「运行数据管道」替换不了它。→ Q1。
2. **「runner 里没有按管道的锁」**：有，且是 DB 级（§1.2）——但只对管道；备料拉取需要自己的在途守卫。→ Q5。
3. **「append 模式的管道」**：管道没有 append/upsert 之分；`mode` 是读模式（`pipelines.cjs:26`），目标适配器只有一个写入口 `upsert`（`pipeline-runner.cjs:669-671`）。幂等与否取决于**目标种类**，不是模式。→ §5 按目标种类分类。
4. **「有界重试放在管道内部」**：runner 没有重试机制（§1.2）；在 runner 里加循环会改动所有受围栏保护的路径。→ Q4 放在动作层、只对写入段之前的失败。

## 2. 决策清单（锁定）

① **两座桥、零新引擎**：Bridge 1 = 动作 `run_integration_job`；Bridge 2 = 触发器 `integration.run_finished`。不做可视化画布、不做逐行事件、不经跨插件通信 API 写、不做无人值守宜搭发送、不做用户自定义连接器种类。**1b/1c 交付的全部作业路径都是试算类**（备料只试算、管道只试算）；两类无人值守写入各有默认关的开关并各有 owner 问题（Q12a、Q12b）。

② **core 持动作，插件供端口**。动作的类型、保存校验、幂等台账、重试分类、审计落在 core（`automation-actions.ts` 的联合类型与两支 CHECK 迁移都在 core）；运行本体与全部围栏留在插件。插件在 `activate` 时向 core 登记 `IntegrationRunPort`（`context.services.integrationRun.register(port)`），core 按插件名记 owner、卸载/重载即解绑、缺席即 `INTEGRATION_RUN_PORT_INACTIVE` 失败关闭——与 `registerPluginWorkdayCalendarProvider`（`index.ts:1772-1782,1784-1794`）同形，且像 `yidaOwnerRuntime` 等能力一样只对 `plugin-integration-core` 开放（`index.ts:3627-3637`）。宿主→插件的既有能力方向（`index.ts:2792-2797`）不变。为什么不是 core 直接 `require` 插件库：会把插件的 B2a/C6 围栏搬进 core 的依赖图，等于绕过插件激活块与 s6a 来源 pin。为什么不是宿主私有运行时（宜搭范式）：宜搭运行时是 core 拥有授权与事务、插件只做组合（`yida-owner-runtime.ts:9-12`，`yida-owner-runtime-factory.mjs:5-8`）；本案的授权与写围栏本来就在插件里，搬家才是风险。

③ **插件侧新增 req-less 的受治理入口**（切片 1b-i）：把 `http-routes.cjs` 里 `pipelinesRun` / `pipelinesDryRun` / 表动作 dry-run+apply 的授权链（`requireAccess` 或 `requireTableActionAccess` → 租户解析 → `assertPipelineRunAllowed` / `assertB2aStockPreparationReadAuthorized` → 读身份委派 → 盖 `runAs:'user'` 与写标记）抽成接受**主体上下文**的函数：`{ user: { id, permissions[], roles[], role, tenantId }, authenticatedTenantId, explicitTenantIds[] }`——正是今天这些检查从 `req` 上读的那几个字段（§1.2）。HTTP 路由用 `req` 构造它（对外字节行为不变，以既有路由测试钉住）；端口由 core 在一个先提交的授权事务里构造（§6.4）。**同一段代码、两个调用方**，不得出现「端口版」的第二套检查；插件不得对上下文加宽、补默认或读别处的权限。入口接受可选的 AbortSignal（不传即今天的行为）。端口**从不**暴露 `replayDeadLetter`。

④ **四个开关**（§7）：Bridge 1、Bridge 2 各一个；备料套用、非试算管道运行各一个。保存时与每次触发时都读原文；关着的动作在触发时记 `skipped(action_disabled)`，不静默成功。

⑤ **每个作业恰好一条摘要事件**，只在动作步的最终尝试之后发（§4.2）；HTTP / 手工 / 回放发起的运行由插件在 `finishRun` 之后经第二个端口 `integrationRunEvents.publish(summary)` 送进 core，自动化发起的运行（端口调用带 `automation` 标识）插件**不**发、由动作层发；core 按闭合键集校验（与 `yida-owner-runtime-factory.mjs` 的 `record()` 同样拒多键、拒 Proxy），再按作业 id 路由。

⑥ **幂等与重试按目标种类与阶段分类**（§5），不按模式。

⑦ **cron 必带时区**（Q9）；`stock_prep_pull` 只接受 `schedule.cron`（不接受 interval）；`pipeline` 试算接受 cron 或 `intervalMs ≥ 15 min`；作业超时 `timeoutMs ≤ 55 min`、默认 30 min（< 4 h 回收阈值；11-06 注 M2，原为 ≤ 3 h）；全部在保存时校验。

⑧ **词表与表变化**：`VALID_TRIGGERS` 增 `'automation'`（`pipelines.cjs:30`；`057:105` 只是注释，无 CHECK）；`automation_rules` 的动作 CHECK 增 `run_integration_job`（1b-ii 迁移）、触发器 CHECK 增 `integration.run_finished`（1c 迁移），up/down 同 `zzzz20260720120000…:28-43` 的形式；新表 `meta_automation_job_leases(scope_key PK, holder, lease_expires_at, fence)`（1b-ii 迁移，§3.4；行只增不删，fence 单调）。

## 3. Bridge 1：动作 `run_integration_job`

### 3.1 配置形状（闭合键集，保存时逐键校验）

```
{ job: { kind: 'stock_prep_pull', projectNos: string[≤20], applyMode: 'dry_run_only' | 'apply_when_ready' }
| job: { kind: 'pipeline', pipelineId, pipelineFingerprint, dryRun: true, mode?: 'incremental' | 'full' | 'manual' },
  timeoutMs ≤ 55 min, 默认 30 min (作为 AbortSignal 传入端口, §3.4; 11-06 注 M2, 原为 ≤ 3h), retry: { maxAttempts ≤ 3, backoffMs ≥ 60000 },
  binding: { principalId, tenantId }  // 服务端盖章，客户端值一律丢弃（同 dataSourceOwnerId 的做法）}
```

- `job.kind` 之外的键、未知 `applyMode`、`mode` 不在 `VALID_MODES`（`pipelines.cjs:26`）、空 `projectNos`、`pipelineFingerprint` 缺失或不等于服务端重算值 → 保存 400。**`pipeline.dryRun` 不是 `true` → 保存 400；`applyMode: 'apply_when_ready'` 在 1b/1c 一律保存 400，不读开关**——开关只是预留的名字与登记，在它控制的切片合并之前，一次提前的开关翻转不能造出「可保存却没有实现」的规则（不是「保存了但触发时跳过」：无人值守写入的意图根本不进规则表）。
- 规则的 `sheet_id` 对 `stock_prep_pull` 必须是这些项目**已登记**的目标表（项目登记表 087，R-66/R-68 口径）；对 `pipeline` 且目标是 `metasheet:multitable` 时必须等于管道目标表；其它目标种类要求创建者对该表 `canManageAutomation` 之外另持 `integration:admin`。这样「谁能在这张表上建自动化」与「谁能跑这个作业」两道门同时成立。

### 3.2 执行序（每次触发）

开关原文判定 → 端口在役 → **实时复核绑定主体并构造主体上下文**（§6.4，授权事务在此**提交**）→ 管道指纹 / 项目状态复核 → **作业租约**（§3.4）→ Tx A 认领意图（`claimOutboundIntent`，kind=`execution`、`actionKey = deriveActionKey(…)`；`sent/outcome_unknown` 即 `alreadyApplied` 跳过；11-04 注 N1：main 现在只把 `skip_sent` 当 `alreadyApplied`，`skip_unknown` / `skip_inflight` 是停下后续步骤的失败步，Tx B 要带认领发的令牌）→ 建 AbortController（`timeoutMs` 到点中止）→ 端口 `run({ context, job, signal, automation: { ruleId, executionId, rootExecutionId, triggerType } })` → 插件受治理入口（§2 ③）→ runner / 表动作 → 返回 values-free 结果 `{ runId?, status, reason?, counts, durationMs, failureStage?, errorClass? }` → 以 fence-CAS 释放租约 → Tx B 记结果 → 动作步结果 → 若为最终尝试，动作层发摘要（§4.2）。

- `stock_prep_pull`（1b/1c）：逐项目顺序执行，**只试算**；`manual_confirm_required`、`suspended`、`PROJECT_ABSENT`、`PROJECT_ARCHIVED` 记 `held`（人工待办，不是失败，缺省不告警——脚本把它们记为跳过而非失败、不改退出码，`stock-preparation-scheduled-pull.mjs:156-160,609-617`）。脚本不传、动作也**不传** `acceptManualConfirmHold / acceptDuplicateResolution`：冲突留给人。**后续切片的契约（不随 1b/1c 交付）**：`applyMode = 'apply_when_ready'` 且 `…_RUN_APPLY_ENABLED === 'true'` 且试算 `ready && canApply` 才在同一步里用刚拿到的令牌套用（与脚本 `:148-150,540-560` 同语义）。
- `pipeline`：**只试算**。端口调用受治理入口的 `dryRun: true` 路径（与 `pipelinesDryRun` 同一条链，`http-routes.cjs:7618-7638`），永不附 `C6_WRITE_LIFECYCLE_CONTEXT`、永不到达 `targetAdapter.upsert`（`pipeline-runner.cjs:669-671`）。非试算运行要等 Q12b 的裁定与 `…_RUN_PIPELINE_WRITE_ENABLED`，不在 1b/1c 的代码里。

### 3.3 绑定变化

管道：保存时服务端算指纹 = sha256(规范化 `{sourceSystemId, targetSystemId, sourceObject, targetObject, mode, fieldMappings}`)；触发时重算不等 → `skipped(pipeline_changed)`；管道非 `active` → runner 自己拒（`pipeline-runner.cjs:408-413`）→ `failed`。项目：登记表里不存在 / 归档 → `skipped`。表被软删 → 调度回调已跳过（`automation-service.ts:1517-1522`）。

### 3.4 并发、重叠与失效（按作业种类）

- **作业租约（core，1b-ii）**：`meta_automation_job_leases` 一行一个作用域，`scope_key = 'stock_prep_pull:<tenantId>:<projectNo>'` 或 `'pipeline:<pipelineId>'`，TTL = **120 秒加心跳**（11-06 注 M3；v3 原为 `timeoutMs + 60 s`，见本节末「11-06 修订」）。认领 = `INSERT … ON CONFLICT (scope_key) DO UPDATE SET fence = leases.fence + 1, holder = $2, lease_expires_at = now() + ttl WHERE leases.lease_expires_at < now() RETURNING fence`（与 `automation-event-fires-lease.ts:26-65` 同一套认领 / 回收 / 单写者语义），认领失败即 `skipped(busy)`。释放 = **fence-CAS UPDATE** `SET lease_expires_at = now(), holder = NULL WHERE scope_key = $1 AND fence = $2`——**永不删行**，所以 fence 真正单调：一个超时的僵尸持有者带着旧 fence 回来释放，0 行受影响，后继者的租约完好（与 `markEventFiresDone` 的 fence-CAS 终态、保留行同一招，`automation-event-fires-lease.ts:67-76`）。两条规则拉同一个项目也串行。管道种类上它是纵深：DB 唯一索引（`058:34-36`）仍是权威，409 同样记 `skipped(busy)`。
- **`timeoutMs` 是会被遵守的中止信号**：动作层建 AbortController、到点 `abort()`，signal 随端口调用传入受治理入口；入口在每个项目之前、每页源读之前检查 `signal.aborted`，并把 signal 交给能收它的下游。今天 runner 与表动作都没有 signal 管道（`pipeline-runner.cjs` 与 `stock-preparation-table-actions.cjs` 里没有 `AbortSignal` 的任何引用），1b-i 加上、不传时行为不变。一次已经发出的源读会跑完再看到 signal——这是**有界**的超跑（一页 / 一个项目），由 TTL 的 60 s 余量吸收（11-06 注 M3：这句不成立——到点不等于结束，超跑也没有固定上界；改由心跳租约与 I-1～I-6 约束，见本节末「11-06 修订」）；中止后动作步按 `failed(timeout)` 结算（试算无写入，可按 §5 有界重试），迟到结果丢弃；即便某个下游忽略 signal，它也只能持有自己的旧 fence，释放不了后继者的租约。
- **跳重叠**：`stock_prep_pull` 只接受 cron（最小粒度 1 分钟但推荐每日），长于一跳的运行让下一跳 `skipped(busy)`，而不是并行；`pipeline` 试算用 interval 时 ≥ 15 min；作业超时 ≤ 55 min（11-06 注 M2，原为 ≤ 3 h）< 4 h 回收阈值，所以陈旧回收**永远不会**回收一条仍在跑的管道运行。
- **备料套用与计划代号**：目标表写锁租约（迁移 100）保证跨进程只有一个写者；**已接受**：以可套用主体做的试算会抬高计划代号，使人工未套用的试算令牌失效（`stock-preparation-project-write-lock.cjs:14-18`）——今天的 OS 任务已如此；建议调度在工作时间之外。租约把两次自动化试算串行化，所以不会出现「同一项目两次并行试算、互烧令牌」。
- **主失效中途**：旧主的在途回调继续跑完（`automation-scheduler.ts:469-483,698-700`），新主下一跳撞租约 → `skipped(busy)`。
- **进程崩溃**：管道——`integration_runs` 行留 `running`，4 h 后被回收为 `failed`（`pipelines.cjs:893-926`）；备料——没有运行行，只有租约（到 TTL 自然过期）与一条 30 分钟后过期的试算令牌记录（runbook `:931-933` 已记的既有缺口）。两种都留下 `pending` 意图行，下次认领翻 `outcome_unknown`（`automation-outbound-intent.ts:237-246`）并由动作层发 `outcome_unknown` 摘要（11-04 注 N1：须意图租约过期之后；租约上限与 `timeoutMs ≤ 3 h` 的关系见 N1；11-06 注 M2 已改为 ≤ 55 min 加意图租约心跳）。多实例部署必须开 `ENABLE_SCHEDULER_LEADER_LOCK`（1b-ii 顺带把它登记进 manifest；11-04 注 N2：#6716 已登记）。

#### 3.4.1 11-06 修订：心跳租约、不变量 I-1～I-6 与停止排空（取代上文「TTL = `timeoutMs + 60 s`」）

> 以下逐字转录自冻结设计基线 v2.3 §10.2.3（`ipaas-yida-dev-baseline-v2.3-20261106.md`）。文中的 § 编号指基线的章节，`path:line` 在基线的代码基线 `aba11f45b` 上核对，实施前要按当时的 main 重核。套用切片（OQ2）以下游目标表写锁围栏为前置（见「还剩的重叠」最后一条）。

**今天的情况**
- **作业超时**：自动化执行器没有步级或执行级超时，只有传输层的 `AbortController`（`automation-executor.ts:4760`、`:5015`、`:6678`；`:4909` 是传输参数里的 `AbortSignal` 类型注解。证据附件 B 的 B3.1 把 `:4909` 也算作 `AbortController`，以本文为准）。
- **中止信号**：运行器和表动作里没有任何 `AbortSignal` 引用（`pipeline-runner.cjs`、`stock-preparation-table-actions.cjs` 各 0 处）。
- **意图租约**（#6715）：默认 120 秒，上限 1 小时（`automation-outbound-intent.ts:60-67`、`:138-146`）。`pending` 且租约有效时跳过；过期后由令牌围栏翻成 `outcome_unknown`（`:237-246`）。
- **作业租约**：还不存在，由 1b-ii 新建。
- **停止**：`stopOnce` 把各项排空任务交给关停栅栏 `waitForShutdownBarrier`，最多等 10 秒（`index.ts:3831-3855`）。到点时栅栏以 `SHUTDOWN_TIMEOUT` 拒绝，`stop()` 跟着拒绝，后面的 `pool.end()`（`:4192`）**不再执行**，连接池留着不关（日志「Shutdown timeout; database pool left open」，`:4169`）。随后信号处理包装 `stopForSignal` 以 `process.exit(1)` 退出（`:3789-3794`；信号注册 `:5361-5362`）。门 10 的关停超时测试（#6747）钉住的正是这一行为。没有任何信号通知在途步骤停下（`automation-service.ts` 里 0 个 `AbortController`）。
- **pm2**：`ecosystem.config.cjs:54-61` 没有停止参数。Windows 下 `pm2 stop` 是否送达 SIGTERM，仓库没有记录（未核实）。

**ADR §3.4 的缺口**（`adr-automation-pipeline-bridge-20261103.md:131-132`，租约 TTL = `timeoutMs` + 60 秒）
1. **到点不等于结束。** 超时后释放租约或等 TTL 过期，后继就可能在前一次调用的尾巴还在跑时开始。
2. **超跑没有上界。** 60 秒余量只是估计；试算最多读 100 页（`stock-preparation-table-actions.cjs:172-173`），任何固定余量都有超过它的输入。
3. **死亡探测变慢。** TTL 跟着 3 小时超时走，进程崩溃后 3 小时内每一跳都 busy，每日任务就是整天不拉。
4. **与意图租约冲突。** 意图租约上限 1 小时。作业跑过约 59.5 分钟后，同身份重放会把它翻成 `outcome_unknown`，原作业写结果时得 `confirmed:false`。
5. **停止不通知作业。** 栅栏到点后进程以 `exit(1)` 退出，在途作业被直接终止，写不出结果，也释放不了租约，只能等 TTL 过期。

**失去心跳不等于进程死亡：两处要闭合的交错**
- **交错一：失主还活着。** A 可能因为进程暂停（GC、虚拟机挂起）或数据库断连而续租失败，于是失去租约，B 在 TTL 后接管。这时：
  - A 已经发出的远端请求可能还在执行；
  - A 恢复后，如果不检查，还会继续读下一页、调下一个项目。
  所以必须保证两点：当前持有者唯一；发现自己已是失主后，拒绝准入任何新调用。已经准入的那一次单次读，属于明确列出的残余（见「还剩的重叠」）。
- **交错二：作业 fence 与意图令牌各管各的。** 意图行按 `(kind, root_execution_id, action_key, target_key)` 定位，结果提交只检查 `status = 'pending' AND attempt_token = 自己的令牌`（`automation-outbound-intent.ts:342-361`）。B 若来自另一条规则或另一个执行根，接管的是同一个作业范围，但用的是另一行意图，不会让 A 的令牌失效。按 v2 的设计，A 恢复后仍能把自己的结果写成功。

**不变量**
- **I-1 持有者唯一**：同一 `scope_key` 任一时刻至多一个持有当前 fence 的调用。后继只能在前者用 fence-CAS 释放之后，或前者的租约在数据库时钟上过期之后认领。
- **I-2 旧 fence 一律无效**：带旧 fence 的释放、续约、结果写都是 0 行；带旧令牌的结果写得 `confirmed:false`。
- **I-3 超时只中止**：超时只发 abort，不释放。释放只在受治理入口的 promise 结束（settle）之后。
- **I-4 停止只加速结束**：停机给在途作业发 abort；结束不了就不释放，交给 TTL 过期处理。
- **I-5 发现失主后拒绝新准入**：
  - 续租失败（0 行、数据库报错或超时）立即触发 `lostSignal`，中止端口；
  - 本地还记一个截止时刻：上次续租成功时刻加 TTL，减去安全余量。过了这个时刻就当作已失去租约，即使还没收到续租失败；
  - **每次新调用之前**（每个项目、每一页、每个远端请求）都通过端口回调 `checkpoint()` 到数据库核验 `fence = 自己的 AND lease_expires_at > now()`，不通过就中止，不准入这次调用；
  - 这条保证的是「发现失主之后不再准入新调用」。在 `checkpoint()` 通过之后才失去租约，那一次已准入的单次读仍会发出，属于明确残余。
- **I-6 提交同时受 fence 与令牌约束，并持有作业租约行锁**：
  - 结果写（Tx B）的第一步是 `SELECT … FROM meta_automation_job_leases WHERE scope_key = $1 FOR UPDATE`，在锁内核验 `holder = 自己`、`fence = 自己的`、`lease_expires_at > now()`；
  - 然后在同一事务里写意图结果（`pending + 自己的令牌` 的 CAS），再用 fence-CAS 释放作业租约，最后提交。行锁一直持到提交；
  - 任一核验失败，或任一 CAS 为 0 行，整个事务回滚，结果是 `confirmed:false`；
  - 只在同一事务里**普通读取** fence 不够：可能出现「检查通过 → B 接管 → A 提交旧结果」。持有行锁后，B 的认领（对同一行的 `INSERT … ON CONFLICT DO UPDATE`）会等到 A 提交才执行，线性化点就是 A 的提交。
- **统一锁顺序**：凡是同时碰作业租约行和意图行的事务（续租、结果写、释放），一律先锁作业租约行，再动意图行。续租事务也是先 `FOR UPDATE` 作业租约行、核验 fence，再续意图租约（以令牌为条件）；任一 CAS 为 0 行就整体回滚，并触发 `lostSignal`。失去作业租约之后，不能再续意图租约。

**还剩的重叠，以及什么时候不能只凭 TTL 接管**
- 按 I-5，发现失主后不再准入新调用，但仍可能有一次读与 B 重叠。每个失主最多一次，有两种来源：
  - 失去租约之前已经发出、仍在执行的那个远端请求；
  - 已经通过 `checkpoint()`、但还没发出的那一次单次串行读：A 在检查通过后暂停，B 接管，A 恢复后照样把这次读发出去。
- 1b/1c 只试算，重叠的只是一次源读或一次试算。代价是试算会推进计划代号，可能让人工手里未套用的令牌失效（`stock-preparation-project-write-lock.cjs:14-18`），不改数据。这一点作为已知残余写进 ADR。
- 如果要求底层请求**绝不重叠**（例如以后的无人值守套用），就不能只凭 TTL 到期接管。写入必须带下游自己的围栏：套用路径已有目标表写锁，它在每次写都用 `lease_id + fencing_epoch + lease_seq` 做 CAS（同文件 `:45-55`），失主的写会被拒。任何套用切片都以此为前置。

**一次调用的顺序**（1b-ii）
1. 认领意图（Tx A），失败则按现有语义跳过。
2. 认领作业租约（拿 fence），失败则 `skipped(busy)`。
3. 起心跳：每 TTL/3 在**一个事务里**按统一锁顺序续租：先 `FOR UPDATE` 作业租约行并核验 fence，再续意图租约（以令牌为条件）。任一 CAS 为 0 行就整体回滚，触发 `lostSignal`。
4. signal = 超时信号、停机信号、`lostSignal` 任一触发。
5. 调用端口 `run({ context, job, signal, checkpoint })`。入口在每个项目、每页之前先检查 signal，再 `await checkpoint()`。
6. 端口结束：停心跳 → 一个事务内完成：`FOR UPDATE` 锁作业租约行并核验 → 写意图结果 → fence-CAS 释放 → 提交（I-6）。
7. 超时到点：abort，再等 `settleGraceMs`。
   - 等到结束：步结果 `failed(timeout)`，照第 6 步收尾。
   - 没等到：步结果 `outcome_unknown(timeout_unsettled)`，不释放，心跳继续；结束后再写结果、释放。
8. 失去租约：步结果 `outcome_unknown(lease_lost)`；不写结果、不释放（已不是自己的），不再续意图租约。之后同身份重放在意图租约过期后把它翻成 `outcome_unknown`。
9. 停机：同第 7 步。所有仍活着的部分都要接进关停生命周期：
   - 提前返回 `timeout_unsettled` 之后仍在跑的端口调用；
   - 心跳；
   - 收尾事务（Tx B 与释放）。
   每一项都用 `observeShutdownTask` 登记进 `stopOnce` 的栅栏（`index.ts:3865` 起），不得另起游离于这条生命周期之外的后台任务。栅栏 10 秒内结束就正常收尾；否则进程按上面的事实以 `exit(1)` 退出，留给 TTL 处理。

**为什么不能只把租约拉长**
- 一个 TTL 同时承担两件相反的事：探测死亡要短，容纳慢工作要长。拉长只顾后者，崩溃后整段 TTL 都 busy。
- 任何有限 TTL 都有比它更长的工作，到点后后继会和前者并行。
- 1 小时是 #6715 有意设的上限，放宽会改变所有 B 类发送的僵尸判定时间。
- 改用心跳：TTL 短（120 秒，与目标表写锁 `stock-preparation-project-write-lock.cjs:132` 同量级），活着的工作一直续，死了 TTL 内回收。写锁已经这样做（同文件 `:1-60`）。

**3 小时与 1 小时的对齐**
- `timeoutMs` 保存上限降到 **55 分钟**（55 分钟 + 30 秒宽限，小于 1 小时上限），默认 **30 分钟**，等于旧任务今天的预算（脚本 `:253`）。
- 意图租约也要心跳：新原语 `renewOutboundLease`，按令牌续期，每次仍截到 1 小时；它与作业租约的续期在同一事务里，并以作业 fence 为条件（I-6）。
- 不放宽 #6715 的 1 小时上限。owner 如果坚持 3 小时，就要接受放宽这个上限，影响所有 B 类发送，不建议。

### 3.5 时区

cron 规则有 `timezone`（`automation-triggers.ts:40-44`）且保存校验 IANA（`automation-service.ts:2785-2800`），但缺省是 UTC。含本动作的 cron 规则：编辑器缺省填 `resolveMultitableBusinessTimezone()`（manifest `:685-695`），保存时无时区即 400。DST 由调度器处理（`automation-scheduler.ts:279-280`）。

### 3.6 套用模式

`dry_run_only`（1b/1c 唯一可保存的值）：只试算、只产生摘要事件（「有变化」当提醒，apply 由人按——沿用 `project-subtree-bridge-design-20260905.md` §2.2 与 runbook 的第一波建议）。`apply_when_ready`：**1b/1c 不实现，保存一律 400、不读开关**；下面是后续切片的契约——写客户表 = 章程 O ②，需 `INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED === 'true'` **且** owner 对该部署逐项批准（§12 OQ2）；生产策略、沙箱默认、写锁、令牌比对全部沿用。

## 4. Bridge 2：触发器 `integration.run_finished`

### 4.1 事件（闭合键集、values-free）

```
{ eventId, occurredAt, job: { kind, pipelineId? | actionId, projectNo? }, runId?, status ∈ {succeeded, partial, failed, held, skipped, not_started, outcome_unknown},
  counts: { read, cleaned, written, failed }, durationMs, attempts, triggeredBy ∈ {automation, api, manual, replay}, errorClass?, reason?, _automationDepth }
```

两个「没跑成」的状态是不同的东西：`held` = **人工待办**，`reason ∈ {manual_confirm_required, suspended, project_absent, project_archived}`——有人要去「拉取待确认」页或去建表、作出生命周期决定，系统没有错；`skipped` = **系统侧跳过**，`reason ∈ {principal_unauthorized, busy, pipeline_changed, stale_plan, action_disabled}`——该跑而没跑，要有人看。没有 `errorSummary` 文本（runner 的 `error.message` 可能带 SQL 片段或值），只有有界的 `errorClass`；没有行、没有字段值、没有连接信息。`projectNo` 是配置标识（脚本 `:535-537` 的同一口径），不是行值。**每个作业恰好一条**；1000 行的拉取 = 1 条事件，不是 1000 条（runner 的逐行循环与 `targetAdapter.upsert` 的唯一调用点 `pipeline-runner.cjs:669-671` 都不发事件，1c 以计数断言钉死）。

### 4.2 产生、去重与派发

- **谁发**：HTTP / 手工 / 回放发起的运行——插件在 `finishRun` 成功返回后调用 `integrationRunEvents.publish(summary)`，`eventId = runId`（确定性）。自动化发起的作业——端口调用带 `automation` 标识，插件**不**发；动作层在**最终尝试**之后发恰好一条，`eventId = sha256(JSON [rootExecutionId, executionId, actionKey, projectNo ?? ''])`（确定性：耐久模式下同一步被重投递时去重，人工 `retryExecution` 是新 executionId、产生新的一条）。中间的可重试失败（§5）只进步输出 `attempts[]`，**不**发事件；所以重试不放大告警。开关关即不发。
- **派发**：core 校验闭合键集 → `_automationDepth` 取自发起它的自动化执行（HTTP 发起的为 0）→ 按 `job` 键查启用的 `integration.run_finished` 规则 → 每条规则 `runWithEventDedup(rule.id, 'integration.run_finished:<eventId>')` → `executeRule`，record-less 载荷（与 `automation-service.ts:4104-4120` 同形）。深度 ≥ 3 即丢弃并 warn（`:145`）：「运行完成 → 规则 → 再运行 → 再完成」最多走三层。
- 触发器配置 `{ job: { kind, pipelineId? | actionId }, statuses: [...] }`，缺省 `['failed','partial','skipped','outcome_unknown','not_started']`——含 `skipped`（授权撤销与 busy 可见），**不含 `held`**：`manual_confirm_required` 是 222 上每日拉取的常规结果（`48h-autonomous-run-record-20260906.md:34`），脚本也把它和 `suspended`、项目不存在 / 归档记为跳过而非失败、不改退出码（`stock-preparation-scheduled-pull.mjs:156-160,609-617`）；20 个项目每天 20 条「人工待办」告警会让告警群被静音。要看人工待办，在规则里显式加 `held`。用独立状态而不是按 `reason` 过滤，是因为触发器只比对闭合的 `statuses`（不给 reason 字符串开比对面），而且「人要办」与「系统没跑」是两种语义，不该靠过滤器区分。创建者须持 `integration:read` 及以上或 `stock-prep:read`，并在触发时实时复核（与 `approval.completed` 的 `automation-service.ts:4097-4101` 同形）；不满足即跳过并 warn。
- 耐久模式：`AUTOMATION_DURABLE_DELIVERY_ENABLED` 开时，新事件族必须进路由清单 v4（新版本，不改 v1–v3，`automation-routing-manifest.ts:80,99`），1c 一并交；清单里没有该族时 publish 失败关闭并记一行 values-free 日志。**已接受**：事件不与运行行同事务提交（插件用自己的 db 门面），`finishRun` 与 `publish` 之间崩溃会丢一条告警，下一跳的运行会再产生事件。

### 4.3 告警（1c 的规则模板）

触发器 `integration.run_finished{statuses: failed, partial, skipped, outcome_unknown, not_started}`（不含 `held`）→ `send_dingtalk_group_message{destinationIds, titleTemplate, bodyTemplate}`；模板变量只有 `run.status / run.reason / run.counts.* / run.job.* / run.durationMs / run.attempts / run.errorClass`（扩展 `automation-executor.ts:1199-1204` 的 `templateData`，仍经 `renderAutomationTemplate`）。群目标仍按 (sheet, 创建者) 绑定（`:6408`）；群消息失败时既有的「通知规则创建者」路径（`:2935-2954`）照常。**告警风暴上限** = 每个作业 1 条（重试系数 ×1，因为只在最终尝试后发）× 每跳作业数（≤ 20 个项目）× 调度频率（备料每日 cron；管道 interval ≥ 15 min），且只数缺省告警状态集里的事件——`held` 产生事件、但在缺省模板下不触发动作，所以常规的每日「待确认」一天 0 条告警；不做跨跳抑制（§10）。

## 5. 重试与幂等分类

| 类 | 既有定义 | 本动作的映射 |
|---|---|---|
| class-A（同事务记录写） | `create/update/delete/lock_record`（`automation-retry-eligibility.ts:18-23`），同事务认领（`automation-action-idempotency.ts:89-113`） | **不是**。作业的写入在插件事务里、不在 core 事务里，core 无法同事务认领 |
| class-B（一次性外发） | 五种 `send_*`（`:25-31`），两阶段意图 + `outcome_unknown`（`automation-outbound-intent.ts`） | **借台账不借分类**：意图行 `(kind='execution', rootExecutionId, actionKey)`（11-04 注 N1：#6715 起键里还有 `target_key`，整动作取空串）复用同一张 `meta_automation_outbound_intent`（不受 `AUTOMATION_CLASSB_OUTBOUND_ENABLED` 开关控制——本动作永远写意图行），但结果分类按下表 |
| **class-C（外部作业，新）** | — | 结果 = 作业终态；可重试性取决于**写入段是否开始**与**目标是否幂等** |

分类规则（代码为准，取代提案里的 append/upsert 措辞）：

- `failureStage ∈ {authority, authorize, load, read, transform}`（授权读取不可用、源不可达、超时、连接拒绝、变换失败）→ `failed`，**可重试**：动作层按 `retry` 有界重试（≤3、≥60 s 退避），每次重试都重新走 §3.2 全序（含实时复核、租约与 Tx A 的 `retry_failed` 翻转）。runner 不加循环，只在抛出的 `PipelineRunnerError` 上带 values-free 的 `failureStage` 与 `errorClass`（1b-i 的唯一 runner 改动）。
- 确定的授权拒绝（主体不在役 / 权限不足 / 租户不符）→ `skipped(principal_unauthorized)`，**不**重试（不是瞬态）。
- `failureStage = write` 且目标为幂等 upsert（`metasheet:multitable`、`data-source:sql-write-gated`，键由字段映射决定）→ `failed`，可重试一次（同键重放只会 upsert 同一行）。1b/1c 的试算路径到不了这一类。
- `failureStage = write` 且目标为非幂等种类（`isGenericHttpWriteKind`，`pipeline-runner.cjs:490,928`），或 `finishRun` 失败（`:1190-1197`）、超时、进程崩溃 → `outcome_unknown`，**永不自动重试**；人工 `retryExecution` 命中意图行的 `skip_unknown` 也不会重跑。
- `stock_prep_pull`：试算幂等 → 可重试；套用一旦消费令牌（`stock-preparation-table-actions.cjs:2149`）即视为写入段开始；**消费之后、写入之前**的 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH` / `TABLE_ACTION_DRY_RUN_NOT_APPLYABLE`（`:3303-3307`）是确定的拒绝（计划已被更新的试算取代）→ `skipped(stale_plan)`，不重试、不算 unknown；写入开始之后的任何歧义 = `outcome_unknown`。
- 行级数据错误：留在死信（`dead-letter.cjs`）与 `partial` 状态，动作**不**重试 `partial`；回放仍只经受治理 HTTP 路由，端口不暴露。
- 真发测试（`realFireTestRunEligibility`）：新动作在 1b 保持 `TEST_RUN_ACTION_UNSUPPORTED`（`automation-retry-eligibility.ts:76-78`）——测试运行不该拉真实 PLM。

## 6. 授权与运行身份

### 6.1 谁能建这样的规则

同时满足：① 对规则所在表 `canManageAutomation`（`sheet-capabilities.ts:106-111`）；② 对作业持运行权——`stock_prep_pull` 要 PULL 梯（`stock-prep:pull ∧ operate ∧ read`，或 `stock-prep:admin`；`http-routes.cjs:1384,1453`、`stock-preparation-workbench-access.cjs:747`）或 legacy `integration:write/admin`、`pipeline` 要 `integration:write/admin`（`http-routes.cjs:1339-1355`）；③ 主体**带租户声明**（无租户平台管理员保存即 400，与脚本 `stock-preparation-scheduled-pull.mjs:32-50` 的拒绝同理）；④ 当 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 开着时租户须为已验证声明（`http-routes.cjs:1668-1671`）。

### 6.2 主体绑定：是谁、怎么成为、变了怎样

- 保存时服务端把 `{ principalId: created_by, tenantId }` 盖进 `action_config.binding`，客户端送来的同名键丢弃（`external-systems.cjs:480-482` 的做法）。改规则的人**不**接管绑定：`created_by` 不变则绑定不变；要换主体须删除重建（与 `approval.completed` 用 `rule.created_by` 复核的既有口径一致，`automation-service.ts:4097-4101`）。
- **推荐的生产绑定**：规则由那个租户绑定的服务账号（runbook `:852-866` 与运行记录 `48h-autonomous-run-record-20260906.md:56` 使用的同一类账号——登录禁用、按期签发令牌）持令牌经自动化 API `POST /sheets/:sheetId/automations`（`univer-meta.ts:22009`）创建，于是 `created_by` = 服务账号，与今天 OS 任务的身份一致，人员变动不影响。该账号须满足 §6.1 的四条（含 `workflow:*` 或平台管理员以过 `canManageAutomation`）。
- **编辑器建的规则绑的是那个人**：此人被停用、丢掉 PULL 梯 / `integration:*` 或换租户，下一跳即 `skipped(principal_unauthorized)` + 摘要事件（缺省告警状态集含 `skipped`）；拉取就此停下，直到有人重建规则。这是有意的失败关闭，不回退到任何其它身份。哪种身份进生产规则交 owner（§12 OQ7）。
- 触发时：主体在役、仍满足 §6.1 ②③、租户相等，三者任一不成立 → `skipped(principal_unauthorized)`；授权读取本身失败（数据库错误）→ `not_started(authority_unavailable)`，按 §5 有界重试。

### 6.3 数据面身份与 owner 停用

读身份不变：`stock_prep_pull` 用服务端盖章的绑定 owner（`http-routes.cjs:6472-6485`），`pipeline` 用 `pipeline.createdBy`（`pipeline-runner.cjs:414-431`），`runAs:'user'` 由受治理入口盖、端口不能自盖（`index.cjs:270` 的同一道理）。宿主数据源门只比 owner 相等（`DataSourceManager.ts:791-801`），所以**绑定 owner 被停用今天不会停下 HTTP 拉取，也不会停下本动作**；是否改为「owner 不在役即拒」交 owner（§12 OQ4）。

### 6.4 端口的主体上下文：谁构造、从哪来

- **core 构造，紧挨着端口调用，事务先提交**：在一个 RC 事务里按 `automation-live-authority.ts:62-124` 的锁序（`user_roles → role_permissions → user_permissions → users → user_orgs → namespace admissions`，`:58-59`）FOR SHARE 读绑定主体的实时状态，组成 `{ user: { id, permissions[], roles[], role, tenantId }, authenticatedTenantId, explicitTenantIds: [] }`，然后 **COMMIT，再调用端口**——FOR SHARE 锁不跨最长 55 min（11-06 注 M2，原写 3 h）的端口调用持有；提交之后的撤权不中止在途作业，这是与宜搭 ADR 相同的已接受窗口。**不**用保存时的声明，**不**让插件自己去读 RBAC（那才是新的授权路径）。
- **拒绝规则是成员关系，不是字段比对**：`users` 行存在且 `is_active`、通过认证门（`evaluateUserAuthenticationGate`），**且** `user_orgs` 对 (principalId, binding.tenantId) **恰有一行且 `is_active`**——与 `automation-live-authority.ts:133-141` 同一条规则；任一不成立 → `skipped(principal_unauthorized)`。上下文里的 `user.tenantId` 与 `authenticatedTenantId` 由这条规则**派生**为 `binding.tenantId`（是事实、不是检查）；`isTenantlessPlatformAdmin`（`http-routes.cjs:1362-1366`）在端口上由构造恒为假，不作为判定；`explicitTenantIds` 永远为空（没有请求、没有查询串、没有请求头）。插件对收到的上下文只读不写。
- **权限集与请求路径同一解析器**：`user.permissions` 必须由请求路径用的同一函数产生——`rbac/service.ts:140` 的 `listUserPermissions(userId, runQuery)` 传入事务查询函数即走事务变体、不经缓存（`:141`），语义与池读相同：`user_permissions ∪ role_permissions ∪ users.permissions` 后过 `filterPermissionCodesByNamespaceAdmission`（`:124-138`）；所以 R-66 ③ 的口径（stock-prep 码只经角色 + 已启用的 `stock-prep` 命名空间准入才算，直接 `user_permissions` 授予被滤掉）在端口上与 HTTP 上逐码一致。**不**用 `automation-live-authority.ts:144-148` 那种不过准入过滤的并集。`role` / `roles[]` 同样取请求路径的判定（`isRbacAdmin`，`AuthService.ts:755-756`）。1b-ii 的等价测试（§11）：四组夹具——角色授予的 PULL 梯、直接授予的 stock-prep 码、持 PULL 梯但无 stock-prep 准入、legacy `integration:write`——端口上下文的权限码与请求期档案（`AuthService.ts:746-762`）的权限码逐码相等。
- **与 RBAC 缓存抖动的关系**：请求期解析器的缓存在代际变动时对并发调用失败关闭为空集（`rbac/service.ts:159-161`；222 上 2026-10-30 观察到的考勤回填抖动即此）；端口走事务变体不经缓存，所以不会因此误判为撤权。读表本身失败归 `authority_unavailable`（可重试），定性的不在役 / 无成员关系 / 权限不足才是 `principal_unauthorized`（不重试）。

### 6.5 租户作用域

动作没有请求、没有请求头，租户只来自保存时冻结的绑定；`x-tenant-id` 请求头在这条路径上不存在，无租户令牌被保存时拒绝——两类历史洞（`x-tenant-id-header-hole`、无租户平台管理员走请求参数）在自动化路径上从源头关闭。规则表没有 tenant_id 列（§1.1），所以 1b **不**给规则表加列：租户落在动作配置的服务端盖章里，并在触发时与表所属 base 的租户比对。

## 7. 开关与上线

| 开关 | 读取点 | 语义 | danger | 打开归谁 |
|---|---|---|---|---|
| `INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED` | core 保存校验 + 执行器每次触发 | 关：含 `run_integration_job` 的规则保存 403 `RUN_ACTION_DISABLED`，既有规则触发记 `skipped(action_disabled)`。只放行试算类作业 | high | T 层梯子 L2（部署仍是 O ④） |
| `INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED` | 插件 `publish` 前 + core 接收时 + 动作层发摘要前 | 关：不发、不收；触发器规则可以保存但永不触发 | medium | 同上 |
| `INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED` | **1b/1c：不读**（`apply_when_ready` 保存一律 400）。后续切片：保存校验 + 动作在试算得到 `ready` 之后、消费令牌之前 | 1b/1c 没有读它的运行路径，它只是预留的名字与登记；后续切片里关 = `apply_when_ready` 保存 400、既有规则退化为只试算并记 `reason: 'apply_disabled'` | high | **O ②**（§12 OQ2） |
| `INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED` | 保存校验（`dryRun:false`）+ 触发时 | 关：`dryRun:false` 保存 400；1b/1c 没有读它的运行路径，它只是为后续切片预留的名字与登记 | high | **O ②/③**（§12 OQ6） |

- 全部 `type: 'boolean'`、`activationValue: 'true'`、不修剪不折大小写、`dependsOn: []`、`conflictsWith: []`，登记在 `scripts/ops/global-history-flag-manifest.mjs` 的 `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED` 之后（格式 `:25-48`，范例 `:51-71`）。清单测试只从源码自动推导 `MULTITABLE_*`（`global-history-flag-manifest.test.mjs:388-392`），所以 1b-ii/1c 要像 `:477-503` 那样为每个新开关写显式读取点测试；顺带登记 `ENABLE_SCHEDULER_LEADER_LOCK`（既有、未登记）。11-04 注 N2：#6716 已登记它；`INTEGRATION_YIDA_CONNECTION_TEST_ENABLED` 之后现紧跟 #6718 的 `INTEGRATION_YIDA_MULTI_TARGET_ENABLED`，#6716 另开了自动化运行时分组（`global-history-flag-manifest.mjs:882-951`），四个新开关放哪一处由 1b-ii 定。
- 与 `AUTOMATION_DURABLE_DELIVERY_ENABLED`：Bridge 1 不受影响（定时执行不是事件）；Bridge 2 在该开关开着时要求路由清单 v4 存在，否则 publish 失败关闭（§4.2）。与 `AUTOMATION_CLASSB_OUTBOUND_ENABLED`：无依赖，本动作的意图行不受它控制（§5）。与 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED`：§6.1 ④。与 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS`：1b/1c 只试算，永不触发它放行的写（`pipeline-runner.cjs:490` 的守卫以 `dryRun !== true` 为前提）。
- 开关切换 = 后端重启 / 重建（pm2 单 fork 启动时读一次 `docker/app.env`，`ecosystem.config.cjs:52,60-61`）。
- 梯子（每级 owner 另批，上一级不自动成立下一级）：L0 合并休眠代码（四开关未设）→ L1 上机、开关仍不设 → **L2 前置**：规则创建者（推荐服务账号，§6.2）的令牌带租户声明——`user_orgs` 恰一行、按 `customer-delivery-guide-20260904.md` §5-5 的次序重签令牌（`http-routes.cjs:1747-1753`）；仍依赖 `x-tenant-id` 的部署在此之前本功能不可用（保存即 400）→ L2 开 Bridge 1 + Bridge 2，建一条只试算的规则与一条告警规则，告警群先用测试群 → L3 停用 OS 任务（§8）→ L4（可选，O ②）开 `…_RUN_APPLY_ENABLED` 并把规则改为 `apply_when_ready` → L5（可选，O ②/③，另一切片）非试算管道运行。

## 8. 222 切换与回退

- **切换前置**：（11-06 注 M4）先读现场计数 **J1 = 0 且 J4 = `dry-run-only`**——J1 是任务动作里参数含 `--apply` 的个数，J4 是脚本日志最后一行汇总的 `mode`；读法见 `runbook-stock-prep-project-sheets-switch-on-20261014.md:178-191`，只报计数与枚举值。任一不成立，只试算的新路径不得替换旧任务；J1 没读到就不得宣称等价替换、不得停用旧任务。要替换含套用的任务，先等 OQ2 裁定、`INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED` 切片完成，再由 owner 按部署逐项批准。完整的五条切换硬门与禁止项见基线 v2.3 §10.2.2。在此之上：L2 的规则至少跑过 3 个自然日且摘要事件与脚本日志一致（计数相等、状态相等）；告警规则对一次人为制造的失败（例如把规则指向一个已归档项目）发出过一条消息（见证红）。
- **切换**（L3，O ④）：在机器上用 `schtasks /Query` 读出实际登记的任务名（runbook `222-deploy-window-runbook-20260901.md:904-912` 给的是**示例**名；`48h-autonomous-run-record-20260906.md:32` 记录的实际登记名与示例不同——以机器上读到的为准，任务名不写进本 ADR 与证据），对它执行 `schtasks /Change /TN <读到的任务名> /DISABLE`，**不删除**任务与令牌文件；同一天观察自动化规则的那一跳。
- **回退** = 把 `INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED` 置回未设并重启，再对同一任务 `schtasks /Change … /ENABLE`。两步都不碰数据：规则留在表里（触发时记 `skipped(action_disabled)`），`integration_runs` 与审计行只增不改。回退不需要迁移回滚：1b-ii/1c 的迁移只放宽 CHECK、增词表与一张租约表，旧代码不会写出新值、也不读新表。
- **令牌**：切换完成并稳定一周后，由客户运维按自己的轮换纪律撤销 OS 任务用的服务账号令牌（`222-deploy-window-runbook-20260901.md:924-928` 把保管与轮换定为客户运维职责，本仓库不含任何默认值）；此前保留以便回退。若生产规则按 §6.2 以同一服务账号创建，撤销的只是 OS 任务那一张令牌，不影响规则（规则不持令牌，只持 `created_by`）。
- **不切换的情况**：若 owner 不批 L2 的任何一步，OS 任务原样保留，本 ADR 的代码在部署上保持休眠。

## 9. 可观测与 values-free

- 自动化执行行：`triggered_by='schedule'`（或触发它的事件）、规则 id、步结果 `{ status, output: { runId, status, counts, attempts[], failureStage, errorClass } }`；不含行值、连接、错误正文。
- `integration_runs` 行（管道种类）：`triggered_by='automation'`、`details.automation = { ruleId, executionId, triggerType }`，其余与 HTTP 发起的运行同形；`details` 不新增任何值面字段。
- 备料审计行（`stock-preparation-audit-store.cjs`）：actor = 绑定主体 id，新增 `source: 'automation'` 与 `ruleId`；「谁要求的」（绑定主体）与「用谁的凭据读的」（绑定 owner）继续是两个事实（`http-routes.cjs:6438-6443` 的既有口径）。
- 日志：动作与端口的所有 Logger 调用只带 `ruleId / executionId / runId / status / errorClass`；主体 id 与租户 id 不进日志行。
- 摘要事件按 §4.1 闭合；测试用计数断言「1000 行 ⇒ 1 条事件」「3 次尝试 ⇒ 1 条事件」「`manual_confirm_required` ⇒ 1 条 `held` 事件、缺省模板 0 条告警」。
- 证据面（issue / PR / 登记册）：只记状态与计数，不记项目号以外的任何配置值；项目号属配置标识，与脚本输出的口径一致；任务名、账号名不入证据。

## 10. 不在本 ADR 范围内

- 可视化流程画布、第三台编排引擎、用户自定义连接器种类、连接器市场。
- 逐行事件、`record.created` 对插件路径写的补发。
- 自动化经跨插件通信 API 或自调 HTTP 发起写入；端口暴露 `replayDeadLetter`。
- **1b/1c 里的任何无人值守写入**：备料套用（Q12a）与非试算管道运行（Q12b）各自等待 owner 裁定与各自的开关，之后作为独立切片另行评审。
- 无人值守宜搭发送（阶段 2 的「发送草稿」动作要在客户机上有一次真实宜搭发送之后另立 ADR，仍受 R-50 发送开关与逐条批准约束）。
- 接活或删除 `integration_schedules`、`data_sync_jobs`、`external_tables` 死表（另案）。
- 入站 webhook 触发管道（Bridge 2 是出站摘要；入站已有 `webhook.received`，是否绑到作业待第二个场景）。
- 跨跳告警抑制（「连续失败只报一次」）、运行时长趋势、仪表盘。
- 试算令牌记录的清扫器（runbook `:931-933` 已记的既有缺口；按日调度量级可忽略）。
- 把 `errorSummary` 分类细化成更多 `errorClass`；连接器选择器、通用宜搭映射、宜搭入站事件（阶段 3，只在第二个客户或场景提出时做）。

## 11. 切片、测试与变异见证

- **PR 0（1a）**：本 ADR + 登记册 R-69（OPEN）。
- **PR 1b-i（插件，只重构，无新调用方）**：把 `http-routes.cjs` 的两条授权链（管道 run/dry-run、表动作 dry-run/apply）抽成接受主体上下文与可选 AbortSignal 的 req-less 受治理入口（§2 ③），HTTP 处理器改为「用 `req` 构造上下文后调用、不传 signal」；受治理入口与表动作加 signal 检查点（§3.4，不传时无行为）；`VALID_TRIGGERS` 增 `'automation'`（只加词、无生产者）。**对外逐字节不变，具体是**：每条受影响路由的请求形状、状态码、成功响应体与错误响应体都不变——既有路由测试全绿 + 一组失败路径的响应体快照测试是验收；改变的只有内部调用形状。另加「用 `req` 构造的上下文 ≡ 处理器此前从 `req` 读到的字段」的等价测试；s6a `pluginIndex`/`pluginHttpRoutes` 来源 pin 重算；test-chain 登记。不动 runner 的错误形状。
- **PR 1b-ii（core 动作 + 端口 + 开关 + 迁移，只试算）**：`automation-actions.ts` 联合类型与配置形状、保存校验（§3.1、§6.1，含 `dryRun` 必为 `true`、`apply_when_ready` 一律 400）、执行器 `run_integration_job`（§3.2、§5；AbortController 与 `failed(timeout)` 结算）、主体上下文构造（§6.4：先提交的授权事务、`listUserPermissions(userId, runQuery)` 事务变体）、作业租约原语与表（§3.4：fence-CAS 释放、不删行）、端口登记与解绑（`index.ts` 的 `registerPlugin…` 同形 + `cleanupPluginRuntimeRegistrations`）、插件端口实现（调用 1b-i 的入口）；runner 错误带 `failureStage/errorClass`——放在 `PipelineRunnerError` 的**自有属性**上、不进 `details`，`sendError` 只序列化 `error.details`（`http-routes.cjs:1021-1035`），所以 HTTP 错误体不变，由路由测试钉住；动作 CHECK 与租约表迁移、四个开关的清单登记与显式读取点测试、`ENABLE_SCHEDULER_LEADER_LOCK` 登记（11-04 注 N2：#6716 已做，1b-ii 不再含这一项）。
- **PR 1b-iii（前端）**：规则编辑器的动作项（作业种类、项目列表、`applyMode` 只显示 `dry_run_only`，开关关时不渲染）、cron 时区缺省与必填、步结果的 values-free 展示。
- **PR 1c（触发器 + 告警模板）**：触发器类型与 CHECK 迁移、事件闭合校验、确定性 eventId 与按作业路由与去重、路由清单 v4、`publish` 端口（插件侧「自动化发起不发」的分支）、模板变量、规则模板（告警群 + 文案）、前端触发器项。
- **真库用例（EXPECT_DB 车道，三处镜像 `plugin-tests.yml` / 文件清单 / `vitest.config.ts` 排除）**：作业租约（同一项目两次并发端口调用 → 恰一次试算 + 一次 `skipped(busy)`；租约过期后可被回收；**僵尸持有者带旧 fence 的释放对新持有者的租约无效**——行保留、fence 单调）；权限等价（四组夹具下端口上下文的权限码 = 请求期档案的权限码，逐码）；授权事务在端口调用前已提交（端口调用期间对该用户 `user_roles` 的 UPDATE 不被阻塞）；一管道一在途（并发两次端口调用恰一次运行、另一次 `skipped(busy)`）；意图行崩溃窗口（Tx A 后杀进程 → 下次 `outcome_unknown`、零第二次运行）；陈旧回收不碰在途运行；写锁租约下的套用互斥；主体上下文从表读（撤权后同一事务内即拒）；CHECK 与租约表迁移 up/down。
- **变异见证（每条守卫先见红再报绿）**：开关读取点改成 `!== 'true'` 必红；**`pipeline` 的 `dryRun:false` 被保存接受、或在 `…_RUN_PIPELINE_WRITE_ENABLED` 未设时被执行必红**；`apply_when_ready` 在 `…_RUN_APPLY_ENABLED` 未设时被保存接受必红；去掉触发时实时复核必红（撤权后仍跑）；端口缺席时回退到 `communication.call` 必红；端口自盖 `runAs:'user'` 或 `C6_WRITE_LIFECYCLE_CONTEXT` 必红（armed 夹具下写入被拒的断言翻转）；保存时接受无租户主体必红；上下文满足 `isTenantlessPlatformAdmin` 仍放行必红；插件对上下文加宽必红（等价测试）；**去掉作业租约认领必红（同一项目两次并发都跑）**；**租约释放改成 DELETE 必红**（僵尸释放之后第三方可在新持有者仍在跑时认领）；入口不检查 signal 必红（到点后仍开始下一个项目 / 下一页）；端口权限集改用不过准入过滤的并集必红（直接授予的 stock-prep 码在端口上放行、HTTP 上拒绝）；`stock_prep_pull` 接受 interval 必红；`manual_confirm_required` 在缺省告警模板下产生告警必红（应为 1 条 `held` 事件、0 条告警）；指纹不比对必红；`failureStage=write` + 非幂等目标被重试必红；消费后 409 被归为 `outcome_unknown` 必红；`intervalMs` 下限与 `timeoutMs` 上限去掉必红；逐行 emit 必红（1000 行夹具事件数 ≠ 1）；中间尝试发事件必红（3 次尝试事件数 ≠ 1）；eventId 非确定性必红（同一步重投递产生两条）；深度守卫去掉必红（三层后仍触发）；摘要多一个键必红；`errorSummary` 进事件必红；日志带主体 id 必红。
- **CI 陷阱清单**：test-chain 完整性（插件新测试要登记 `test-chain.txt`）、s6a `pluginIndex` / `pluginHttpRoutes` 重 pin（1b-i 必动 `http-routes.cjs`）、EXPECT_DB 三处镜像、guarded-paths 与 `integration-guard.yml` 集合相等、开关清单源码推导与显式测试、`index.ts` this-census 冻结字面量（新增 `this.X` 必跑完整 core-backend 单元套件）、web spec 变异锚点唯一性、`EXPECTED_OPS_TESTS_COUNT`（若动 `scripts/ops/__tests__`）。

- **11-06 补：生命周期验收 T1～T8、T10～T12**（11-06 注 M5；逐字转录自冻结设计基线 v2.3 §10.2.5，§ 编号指基线；T9 是开发机手工检查，不进 CI）：

| # | 场景 | 断言 | 变异见证（去掉守卫必红） |
| --- | --- | --- | --- |
| T1 | 超时到点，旧调用仍在跑 | 后继得 `skipped(busy)`；fence 不变；步结果 `outcome_unknown(timeout_unsettled)`；端口结束后才写结果、释放，之后的触发才能跑 | 去掉「结束后才释放」 |
| T2a | 租约到期而持有者还活着 | 10 个 TTL 内后继一直 busy；到期时间单调前进 | 关掉心跳 |
| T2b | 持有者死了（真库，两条连接） | B 在 TTL 后拿到 fence+1；A 迟到的释放 0 行、结果写 `confirmed:false`；A 的下一次心跳 0 行并自中止 | 释放改成删除行 |
| T3 | 中途重启 | TTL 内 busy，TTL 后可跑；同身份重放在意图租约内跳过，过期后翻 `outcome_unknown`，恰好一条摘要 | 去掉意图租约过期判定 |
| T4 | 围栏 | 旧 fence 的释放、续约，以及旧令牌的结果写，全部无效；行数不变；fence 严格递增 | 释放语句去掉 fence 条件 |
| T5a | 停机，端口响应 signal | 下一个检查点中止；结果 `failed(shutdown)`；释放；栅栏内结束 | 去掉停机 abort |
| T5b | 停机，端口不响应 signal | 不释放、不写结果；重启后 TTL 内 busy | 栅栏到点就释放 |
| T6 | 到点后底层工作继续，之后结束 | 期间后继 busy；结束时结果写成功（意图租约靠心跳续着） | 去掉意图租约心跳 |
| T7 | 3 小时与 1 小时 | `timeoutMs` 为 55 分钟 + 1 毫秒时保存 400；2 小时假时钟运行中，同身份重放始终跳过，意图行从不被翻 | 上限改回 3 小时 |
| T8 | 插件入口检查点 | 第 1 页后中止就不读第 2 页；不传 signal 时请求与响应和快照逐字节相同 | 去掉检查点 |
| T9 | Windows 下停止是否优雅（开发机手工，不进 CI） | `pm2 stop` 后看 `index.ts:3871` 的日志行是否出现，只报 True/False | — |
| T10 | 暂停或断连 → **不同执行根**的 B 接管 → A 恢复（真库，两条连接，数据库时间加屏障；A 没有死） | 隔离 PG 上用短期合成租约（例如 TTL 2 秒）。A 停在屏障上不续租，或断开 A 的连接，等租约在数据库时间上过期；另一条规则（不同 `root_execution_id`）的 B 认领 fence+1 并开始跑。A 恢复后：<br>A 的下一次 `checkpoint()` 失败，端口不再发起调用（源读页数、项目数计数不再增加）；<br>A 续作业租约和意图租约都是 0 行；<br>A 的结果写 `confirmed:false`，尽管 A 的意图令牌本身仍然有效；<br>全程只有 B 的结果写成功；A 的步结果是 `outcome_unknown(lease_lost)` | 结果写去掉作业 fence 条件，A 写成功；去掉调用前的 `checkpoint()`，A 继续读下一页；意图续期不检查 fence，A 续成功 |
| T10b | A 已核验、尚未提交时，B 尝试接管（真库，两条连接，屏障控制交错） | A 的结果写事务已 `FOR UPDATE` 锁住作业租约行并核验通过，停在屏障上，还没提交；等这份短期合成租约在数据库时间上过期，再让 B 去认领。<br>断言：B 的认领一直阻塞，直到 A 提交；A 提交后 A 的结果写成功、租约已释放，B 随后以 fence+1 认领；不出现「B 已接管、A 仍提交了旧结果」。<br>另一例：A 在锁内核验时租约已过期，A 整体回滚，B 正常认领 | 结果写里把 `FOR UPDATE` 换成普通读取，B 不阻塞，A 提交旧结果；续租不按统一锁顺序，并发续租与结果写会死锁或交错 |
| T11 | 续租失败立即中止 | 让续租语句报错或超时（不是 0 行）：`lostSignal` 触发，端口在下一个检查点中止，此后不再发起任何调用；本地截止时刻过了也一样（模拟时钟跳过 TTL，数据库还没回应时） | 续租报错时只记日志不触发 `lostSignal`；去掉本地截止时刻 |
| T12 | 停机排空包含所有仍活着的部分 | 一次调用先以 `timeout_unsettled` 提前返回，端口、心跳仍在跑；此时调用 `stop()`：<br>端口调用、心跳、收尾事务都已登记为关停任务；<br>栅栏等它们结束，10 秒内结束则正常收尾；<br>超时则 `stop()` 以 `SHUTDOWN_TIMEOUT` 拒绝，连接池不关，与 #6747 的关停测试一致 | 不登记心跳或收尾事务；在 `stopOnce` 之外另起后台任务 |

另外沿用 ADR §11 已列的用例：同项目两次并发调用，恰好一次试算加一次 `skipped(busy)`；陈旧回收不碰在途运行；1000 行只发一条事件。

**时间怎么控制**
- JavaScript 的假时钟推进不了 PostgreSQL 的 `now()`。
- 凡是租约过期由数据库判断的真库用例（T2b、T3、T4、T10、T10b），一律在隔离 PG 上用短期合成租约（秒级 TTL），按数据库时间等它过期，并用屏障控制交错。
- 假时钟只用于不经数据库判断时间的单元用例（如 T1、T2a、T6、T7 的假端口部分）。
- 不修改系统时钟。

## 12. 待 owner 裁定

1. **OQ1 范围**：动作覆盖「备料拉取（表动作）」与「数据管道」两种作业、1b 先交拉取；接受本 ADR 对已批提案措辞「运行数据管道」的修正（Q1）。
2. **OQ2 无人值守备料套用**：是否进入计划；若进入，`INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED` 的打开与每条 `apply_when_ready` 规则为 O ② 逐项批准（Q12a）。
3. **OQ3 222 切换**：L1 上机、L2 前置（租户声明令牌）与开开关建规则、L3 停用 OS 任务、令牌撤销时点（§7 梯子、§8；O ④）。11-06 加两个子问：(a) J1 的现场确认（任务动作里参数含 `--apply` 的个数，期望 0）；(b) J6（过去有没有人手动带 `--apply` 跑过脚本；为「是」时，人工 `--apply` 的日志行不参与并行期比对）。不新增 OQ；无人值守套用仍归 OQ2，非试算管道仍归 OQ6。
4. **OQ4 绑定 owner 停用**：是否要求绑定数据源的 owner 在役，否则拒跑（今天不拒，Q14）。
5. **OQ5 告警目的地**：首个真实钉钉群与接收人（真实发送 = O ④）；测试群阶段用合成失败见证。
6. **OQ6 无人值守非试算管道运行**：是否进入计划；若进入，`INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED` 的打开按目标种类分别批准——`metasheet:multitable` 目标是生产写入（O ②，且休眠部署上没有 C6 生命周期，`http-routes.cjs:6320`），HTTP 允许清单目标是外部回写（O ③）；1b/1c 不含这条路径（Q12b）。
7. **OQ7 生产规则的身份**：推荐由租户绑定的服务账号经 API 创建（与 OS 任务同一身份类别），备选由指定管理员在编辑器创建并接受「此人停用即停拉并告警」（§6.2）。
8. **T 层默认、24h 可否决**：四个开关名、重试 ≤3/≥60 s、`stock_prep_pull` 只认 cron、interval ≥ 15 min、timeout ≤ 55 min、默认 30 min 且作为 AbortSignal 传入、作业租约 TTL 120 s 加心跳与 fence-CAS 释放、意图租约心跳 `renewOutboundLease`（11-06 注 M2、M3；v3 原为 timeout ≤ 3 h、租约 TTL = timeout + 60 s）、`'automation'` 词项、指纹键集、`held` 与 `skipped` 两个状态及其 reason 闭集、事件缺省告警状态集（含 `skipped`、不含 `held`）、只在最终尝试后发摘要、告警不做跨跳抑制。
9. **R-69 登记行**（OPEN → RULED 由 owner 一并裁定）。

## 附注：2026-11-04 重冻结（`8f3867da7` → `b36f53c2f`）

合并 main 后逐条重核全部 `path:line`：行号漂移已改到新基线；下面五条是 main 在这段时间里改变（或确认未变）的、本 ADR 依赖的事实。正文结论**没有**因此改写，受影响处标「11-04 注 Nx」；需要改的设计细节留给对应切片的评审。

- **N1（#6715，外发意图台账）**：意图行现在带尝试令牌、租约与 `target_key`（`automation-outbound-intent.ts:9-24`，迁移 `db/migrations/zzzz20261103120000_outbound_intent_attempt_lease_target_key.ts`）。对本 ADR 的影响：① `pending` 行只有在租约过期后才被翻成 `outcome_unknown`（`automation-outbound-intent.ts:203-214,237-246`），租约内的认领得 `skip_inflight`、不发送也不宣告对方已死——Q13 与 §3.4 的「下次认领翻 unknown」应读作「租约过期后的下次认领」。② 只有 `skip_sent` 是 `alreadyApplied`；`skip_unknown` / `skip_inflight` 是失败步、停下后续步骤直到对账（`automation-executor.ts:3931-3947`）。§3.2 原写的「`sent/outcome_unknown` 即 `alreadyApplied` 跳过」由此作废，`run_integration_job` 沿用 main 的这条语义（更保守，失败关闭）。③ Tx B 必须带认领发的令牌，返回 `confirmed`（`automation-outbound-intent.ts:342-365`）；步骤只在 `confirmed` 为真时报成功。④ **租约上限与作业超时有冲突**：租约上限 1 h（`:60-67`），`outboundLeaseForTimeout` = 超时 + 30 s 再截到上限（`:143-146`），而 §2 ⑦ 允许 `timeoutMs ≤ 3 h`。跑过约 59.5 min 的作业，意图租约会在作业还在跑时过期；同一身份的重放（耐久重投递或人工 `retryExecution`）会把它翻成 `outcome_unknown`，原作业的 Tx B 因此得 `confirmed:false`。作业租约（§3.4）仍挡住第二次运行，所以不会重复写；但结果记不进去。1b-ii 必须二选一：把 `timeoutMs` 封顶在租约上限减宽限，或为本动作单独放宽上限。两者都属 T 层，留给 1b-ii 评审，本 ADR 不改 `≤ 3 h` 的默认值。**11-06 注 M2：选「降上限 + 意图租约心跳」**——`timeoutMs` 保存上限 55 min（55 min + 30 s 宽限 < 1 h）、默认 30 min；意图租约用新原语 `renewOutboundLease` 按令牌续期、每次仍截到 1 h，并与作业租约的续期在同一事务里、以作业 fence 为条件；**不放宽** #6715 的 1 小时上限。⑤ 整动作意图的 `target_key` 是空串（`:60-61`）；要不要按项目用 `deriveOutboundTargetKey`（`:156-166`）给每个项目一条意图行，由 1b-ii 定。
- **N2（#6716 / #6715 / #6718，开关登记）**：`ENABLE_SCHEDULER_LEADER_LOCK` 与 `SCHEDULER_LEADER_LOCK_TTL_MS` 已登记（`global-history-flag-manifest.mjs:930-951`），`AUTOMATION_CLASSB_OUTBOUND_ENABLED` 由 #6715 登记（`:860-870`）。§1.1、§3.4、§7、§11 里「未登记 / 1b-ii 顺带登记」那几项已经在 main 上完成，1b-ii 只登记本 ADR 的四个新开关。`INTEGRATION_YIDA_CONNECTION_TEST_ENABLED` 后面现在紧跟 #6718 的 `INTEGRATION_YIDA_MULTI_TARGET_ENABLED`（`:72-82`）。
- **N3（#5619 / #5649，webhook 发送时目标检查）**：规则驱动的 `send_webhook` 在发送时过 SSRF 守卫、不跟随重定向（`automation-executor.ts:4661` 起）；webhook 订阅投递同样接了守卫（`webhook-service.ts`）。本 ADR 的告警走 `send_dingtalk_group_message` / `send_dingtalk_person_message`，不用 `send_webhook`，结论不变；以后若有切片用 webhook 发告警，就继承这道守卫。
- **N4（#6714 / #6718，宜搭 v3 映射与多目标）**：v3 映射只在本地预览、本地重算；多目标由 `INTEGRATION_YIDA_MULTI_TARGET_ENABLED` 控制，默认关。§2 ② 引的范式（`yida-owner-runtime.ts:9-12`：授权与事务归 core）没变；§10 把「无人值守宜搭发送」「通用宜搭映射」排除在范围外，这条也不变——v3 映射不是发送路径。
- **N5（#6717，数据源凭据加密）**：宿主数据源门只是下移两行，仍然是严格的 owner 相等、平台管理员例外（`DataSourceManager.ts:791-801`），Q14 / §6.3 / OQ4 照旧。

## 附注：2026-11-06 修订（按冻结设计基线 v2.3 §10.2.6）

基线：`ipaas-yida-dev-baseline-v2.3-20261106.md`（同目录，冻结；代码基线 `aba11f45b`）。本次只改措辞与设计约束，不改代码；正文受影响处标「11-06 注 Mx」。

- **M1（旧任务做什么）**：脚本的能力是 `dry-run → apply`，但只在显式传 `--apply` 时才在同一次运行里套用（脚本 `:148-150`、`:630-640`）；不传时 `ready` 记 `skipped_dry_run_only`（`:25-30`、`:147`、`:747`）。222 登记的任务是每日 06:00、只试算、不带 `--apply`（`customer-delivery-guide-20260904.md:234-236`；`48h-autonomous-run-record-20260906.md:32`），10-14 的最后一次记录为 result=0、`skipped_dry_run_only`（`runbook-stock-prep-project-sheets-switch-on-20261014.md:401`）。10-14 之后没有人读过任务参数，现状以现场计数 J1–J7 为准（基线 §10.2.1）。改在 Q1、§1.3。
- **M2（作业超时）**：`timeoutMs ≤ 3 h` 改为 ≤ 55 min、默认 30 min（等于旧任务今天的整次预算，脚本 `:253`）；选「降上限 + 意图租约心跳」，不放宽 #6715 的 1 小时上限。改在 §2 ⑦、§3.1、§3.4、§6.4、§12 第 8 条、N1 ④。
- **M3（作业租约）**：TTL 由 `timeoutMs + 60 s` 改为 120 秒加心跳；补不变量 I-1～I-6、步结果 `timeout_unsettled` 与 `lease_lost`、「失去心跳不等于进程死亡」的两处交错、已知残余（每个失主最多一次读：仍在途的，或已通过 `checkpoint()` 尚未发出的）、I-6 的行锁与统一锁顺序；套用切片以下游写锁围栏为前置。见 §3.4.1。
- **M4（切换前置）**：§8 的 L3 前置加 J1 = 0 与 J4 = `dry-run-only`；OQ3 加 J1 现场确认与 J6 两个子问，不新增 OQ。
- **M5（验收）**：§11 加 T1～T8、T10～T12（T9 为开发机手工检查）。
- **仍待定**（基线 §10.2.6）：Windows 停止信号是否送达（T9）；`timeout_unsettled` 是否进默认告警（T 层默认：告警）；意图租约心跳要不要推广到既有 B 类发送（本期不推广）；多实例时要开 `ENABLE_SCHEDULER_LEADER_LOCK`，且时钟差小于 TTL/3。
- 登记册 R-69 的对应措辞在同一 PR 里修订。

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
