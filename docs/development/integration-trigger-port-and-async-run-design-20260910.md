# 集成触发端口与异步运行设计（IntegrationRunPort / Worker / 告警）—— 2026-09-10

> **本文是设计，未实现。** 仓库里没有一行对应代码，本稿只定契约、状态机、分刀与不变式。
> 对应差距：**G04**（平台触发器到不了数据工厂管道）、**G06**（管道在 HTTP 请求内同步跑完、无取消无进度）、**G07**（失败零告警）；**硬前置 G05**（规则驱动 `send_webhook` 无 SSRF/自环守卫）。
> 差距编号与表述取自 `docs/research/data-factory-page-and-capability-gap-analysis-20260910.md`（分支 `origin/docs/data-factory-gap-analysis-20260910`）。**注意 G04 在该报告里是"被驳回"条目**（附录 C）：反驳者证明"三类触发器都到不了管道"这一硬可达性断言为假——存在 `schedule.cron` → `send_webhook` → 自家 run 路由这条产品内旁路。残核是"没有受治理的绑定端口"，本文按残核写。**该报告中不存在 G54**（正文最大编号 G46 + X01–X08，附录 A 只统计到 58 条），归因一节按其自身理由论证，不引 G54。
> 行号基线：worktree `HEAD = 11dddc18b`（gap 报告基线是 e89f3e15e，因此个别行号与报告有偏移，例如 `plugin.json` 的 `events.emit` 报告记 :15-16、本基线为 :17-18）。

---

## 0. 现状证据表（全部 file:line，本基线实读）

| # | 事实 | 证据 |
|---|---|---|
| E1 | run 状态词表已含 `pending`/`cancelled`，触发词表已含 `cron`，均无生产者 | `plugins/plugin-integration-core/lib/pipelines.cjs:27,28`；`packages/core-backend/migrations/057_create_integration_core_tables.sql:105,106` |
| E2 | run 路由 `await runner.runPipeline(...)` 之后才回 202；dry-run 回 200，同样同步 | `plugins/plugin-integration-core/lib/http-routes.cjs:5420,5443`；路由表 `:58,59` |
| E3 | 四处 run 入口的 `triggeredBy` 全部硬编码 `'api'` | `lib/http-routes.cjs:5403,5437,5673,9711` |
| E4 | 分页循环在一个函数里跑完，无取消检查点 | `lib/pipeline-runner.cjs:1016`（`while (page < maxPages)`）、`:947`（startRun）、`:1166,1201`（两处 finishRun） |
| E5 | 水位推进条件与 `rowsFailed===0 && !maxPagesReached` 绑死 | `lib/pipeline-runner.cjs:1148,1149` |
| E6 | `abandonStaleRuns` 默认 4h，且**唯一调用点**是下一次 `runPipeline` 开头 | `lib/pipelines.cjs:756,763-765`；调用点 `lib/pipeline-runner.cjs:935-944` |
| E7 | 同 pipeline 并发由 DB 部分唯一索引兜底，应用层先抛 409 | `packages/core-backend/migrations/058_integration_runs_running_unique.sql:34-36`；`lib/pipelines.cjs:32,637-650` |
| E8 | `finishRun` 之后没有任何 notifier / emit | `lib/run-log.cjs:82-128`；`lib/pipeline-runner.cjs:1164-1195` |
| E9 | `plugin.json` 申报 `events.emit`/`events.listen`，`index.cjs` 零调用 | `plugins/plugin-integration-core/plugin.json:17,18`；`index.cjs` grep `context.events` = 0 |
| E10 | `integration_schedules` 是死表：除迁移外只出现在迁移测试的表清单里 | `migrations/057:165-177`；`plugins/plugin-integration-core/__tests__/migration-sql.test.cjs:26,34` |
| E11 | `integration_runs` 无任何 actor 列 | `migrations/057:99-115`（全列） |
| E12 | Automation 11 种触发器；EventBus 只接 4 个 multitable 事件 | `packages/core-backend/src/multitable/automation-triggers.ts:19,87`；订阅点 `automation-service.ts:1072-1090` |
| E13 | Automation 16 种动作，无"运行集成管道" | `multitable/automation-actions.ts:35-51` |
| E14 | `send_webhook` 直取 `config.url` / 展开 `config.headers`，仅在有 secret 时补 HMAC | `multitable/automation-executor.ts:4107-4123,4136-4144`；配置形状 `automation-actions.ts:144-151` |
| E15 | SSRF 守卫存在但**只被按钮路由调用**（这就是 G05 的洞） | `multitable/webhook-ssrf-guard.ts:89`；唯一调用方 `routes/multitable-button.ts:57,358` |
| E16 | 定时规则由 AutomationScheduler 回调执行，先查 sheet liveness 再执行动作 | `multitable/automation-service.ts:1015-1039` |
| E17 | `automation_rules` 无 `tenant_id`；`meta_sheets` 无 `tenant_id`；`ExecutionContext` 不带租户 | `src/db/migrations/zzzz20260413120000_create_automation_rules.ts:24-36`；`zzz20251231_create_meta_schema.ts:7-15`；`multitable/automation-executor.ts:1410-1430` |
| E18 | 新增动作类型需要一版 CHECK 约束替换迁移（既有形状） | `src/db/migrations/zzzz20260508120000_add_send_email_automation_action.ts:31-41` |
| E19 | 平台已有 durable 作业范式：claim 守卫、逐行取消检查、终态守卫、孤儿回收 | `services/ai-bulk-job-service.ts:609-618`（claim）、`:662-668`（cancel 检查点）、`:530-534`（cancel）、`:470-490`（reconcile，且自述只有启动扫、无周期扫 `:36-47`） |
| E20 | 宿主定时器 + 可选 Redis leader lock + 插件注册 job body 的既有缝 | `services/AttendanceScheduler.ts:310-316,333-349`；注入 `src/index.ts:2421-2423`；开机接线 `src/index.ts:3784-3792` |
| E21 | 插件 `context.queue` 是**桩**：push 只打日志返回假 id，process/cancel 空实现 | `src/index.ts:1213-1225` |
| E22 | 按 plugin 名注入的最小权限宿主端口范式（本设计端口照抄此形） | `src/index.ts:3102-3107`；实现 `services/tenant-principal-directory-boundary.ts:107-140`（进两个 id、出一个布尔、fail-closed） |
| E23 | 插件内已有 DB 租约原语：INSERT 获取 + 过期 CAS 接管 + CAS 续约 | `lib/stock-preparation-confirmation-decisions.cjs:819-880`；表来自 `migrations/077_create_integration_stock_prep_confirmation_reconcile_lease.sql` |
| E24 | 插件内已有 durable 作业 + 取消 + principal/actor 分离 | `lib/stock-preparation-large-bom-jobs.cjs:487-495`（durable 硬要求）、`:585`（actor≠principal）、`:645-672`（cancel） |
| E25 | 入站 webhook 有 HMAC + 300s 重放窗，但**全文无 eventId / 去重概念** | `multitable/automation-inbound-webhook.ts:1-11`；路由 `routes/automation.ts:253-256` |
| E26 | 记录事件线已有 durable outbox + 路由清单，未登记的 eventType 是**硬错** | `multitable/automation-outbox-enqueue.ts:18-19`；`multitable/automation-routing-manifest.ts:76-90,100-107` |
| E27 | 前端唯一 run 调用方读的是同步返回体 | `apps/web/src/services/integration/workbench.ts:1179-1190` |
| E28 | 今天真正的"定时"是仓外 OS 计划任务脚本打 table-action 路由 | `scripts/ops/stock-preparation-scheduled-pull.mjs:369,373` |
| E29 | 租户在插件侧由 `resolveTenantId` 判定，W4 硬门默认 OFF | `lib/http-routes.cjs:1028-1052,1221`；开关 `:1317-1319` |
| E30 | 运行写围栏挂在 HTTP 路由上（B2a/C6），不在 runner 入口 | `lib/http-routes.cjs:4214-4238` |
| E31 | `abandonStaleRuns` 的过期判据只有 `started_at`；回收 UPDATE 的 WHERE 里没有 `status` 谓词（不是 CAS） | 判据 `lib/pipelines.cjs:773-776`；UPDATE `:781-789`（WHERE = `tenant_id`/`workspace_id`/`id`）；阈值 `:763-765` |
| E32 | 正常终态写路径同样没有终态守卫，回收与完成两条路径后写者胜 | `lib/run-log.cjs:108-126` → `lib/pipelines.cjs:682-686`（WHERE 同为三键等值） |
| E33 | `integration_runs` 没有租约列 / 心跳列 / `updated_at`；时间维度只有 `started_at`、`finished_at` | `migrations/057:99-117`（全列）；此后对该表只加过 `provenance_events`（`migrations/060_integration_runs_provenance.sql:14-15`） |
| E34 | 既有测试已演示"缩阈值→误杀在跑的 run"：15 分钟阈值把一条 30 分钟前开始、仍 `running` 的 run 判成 failed | `__tests__/pipelines.test.cjs:640-648` |
| E35 | 插件 db helper 的 where 只生成等值 / IS NULL；`gte/lte` 只在 `select` 的 `range` 参数上，`updateRow` 走前者 | `lib/db.cjs:103-113`、`:325`、`:121-151`、`:170-177` |
| E36 | E23 的 renew 没有"未过期"前置判，且续约不更换 `lease_id`；接管 CAS 只认 `lease_id` | renew `lib/stock-preparation-confirmation-decisions.cjs:869-878`；接管 `:859-867` |
| E37 | 事务内行锁复判的既有先例（`db.transaction` + `selectOneForUpdate`） | helper `lib/db.cjs:353-380`、`:205-219`；用例 `lib/stock-preparation-handoff-store.cjs:245,366`，理由注释 `:173` |

---

## 1. 端口形状

### 1.1 `IntegrationRunPort.request()`

宿主拥有的最小权限端口，按 plugin 名注入（照 E22 的 `tenantPrincipalDirectory` 形状：宿主持表、持 SQL、持连接池；插件只提交 handle）。

```
request({
  pipelineId,                       // 必填
  mode: 'incremental'|'full',
  dryRun: boolean,                  // 缺省 true
  trigger: { source, ruleId?, scheduledFor?, providerEventId?, clientToken? },
  actor: { userId }                 // 谁发起（不是"用谁的凭据"）
}) -> { requestId, status: 'queued'|'duplicate'|'refused', refusalCode? }
```

出参 values-free：只有 handle、状态与拒绝码，**永不回业务值、永不回租户以外的存在性信息**。

- **租户不是入参。** 宿主用 `actor.userId` + pipeline 行自身的 `tenant_id` 做一次成员校验（`user_orgs`，与 E22 同一谓词），不匹配 → `refused: ACTOR_NOT_IN_TENANT`，不入队。调用方无法通过参数改写租户。
- **凭据不是入参，写授权不随请求走。** 请求行里没有 token/url/header 列，执行时的写围栏仍在插件侧独立判（E30）。

### 1.2 插件如何申报可被触发的管道

不新增申报表。可触发性 = `integration_pipelines` 行上的一个显式字段（`triggerable BOOLEAN DEFAULT false`，随刀 1 迁移）+ 现有 `status='active'`（`pipelines.cjs:26`）。理由：pipeline 已经是租户/工作区作用域内的一等对象，另起"可被触发清单"会立刻产生两套真相。宿主入队前查这一位，false → `refused: PIPELINE_NOT_TRIGGERABLE`。

### 1.3 `integration_run_requests` 列与状态机

列：`id`、`tenant_id`、`workspace_id`、`pipeline_id`、`mode`、`dry_run`、`trigger_source`、`trigger_ref`、`requested_by`、`dedupe_key`、`status`、`cancel_requested`、`progress JSONB`、`lease_id`、`lease_expires_at`、`lease_epoch`（整数，renew 每次 +1，回收 CAS 的乐观并发令牌，§3.1.3）、`attempts`、`not_before`、`run_id`（→ `integration_runs.id`，可空）、`refusal_code`、`error_summary`、`created_at`、`updated_at`。

状态机：`queued → leased → running → {succeeded|partial|failed|cancelled}`；旁路 `queued → cancelled`（还没起跑就撤）、`queued → refused`（入队时判死）、`leased → queued`（失去租约或撞 E7 的 409，`attempts+1`、`not_before` 退避）。

两条唯一约束，缺一不可：

1. `UNIQUE (tenant_id, dedupe_key)` —— 至少一次投递的去重键。cron = `ruleId:pipelineId:scheduledFor`；webhook = `ruleId:pipelineId:providerEventId`；人工 = `actorId:pipelineId:clientToken`（与 `docs/integration-consolidation-minimal-plan-20260901.md:294-297` 的既有设想一致，并额外把 `pipelineId` 拌进键，见风险 R2）。
2. `UNIQUE (tenant_id, COALESCE(workspace_id,''), pipeline_id) WHERE status IN ('queued','leased','running')` —— 同 pipeline 至多一条在飞请求。这条是 E7 的队列侧对偶：没有它，队列会堆 N 条 queued，worker 逐条撞 409 空转。第二条请求答 `duplicate` 并回既有 `requestId`（幂等，不是错误）。

### 1.4 为什么是"请求"而不是"直接调用"

1. **触发侧没有租户身份**（E17）。让 Automation 动作直接调 runner，就必须现场编一个租户——那正是 `x-tenant-id` 请求头洞的形状，只是搬进了内网。请求表让宿主在**入队那一刻**把 actor→tenant 钉死一次并落库，之后 worker 只信这一行。
2. **两次授权判定分属两层**：入队判"这个人在这个租户能不能触发这条管道"（宿主，掌握 `user_orgs`）；执行判写围栏与 B2a/C6（插件，E30）。请求行是两层之间**唯一**的凭证载体，且它不携带任何权限。
3. **取消/进度/归因需要一个可指向的持久对象**。直接调用没有这个对象，`cancel_requested` 无处可写。

---

## 2. 触发面

- **新动作 `run_integration_pipeline` 携带**：`pipelineId`、`mode`、`dryRun`（缺省 **true**）、`note`。
  **绝不携带**：`url` / `host` / `headers` / 任何 token / `tenantId` / `workspaceId` / apply 标志。配置形状是闭集，未知键保存即 400——与 `SendWebhookConfig`（E14）刻意相反：那条动作的"任意 URL + 任意 header"正是 G05 的洞。落地需要一版 CHECK 约束替换迁移（照 E18）。
- **默认 dry-run。** 无人值守写入必须由 pipeline 侧另一位显式开关授权（本设计不做），"只试算、人来按 apply"的备料口径不变。
- **`cron` 槽位由谁填**：Worker 在把请求转成 run 时按 `trigger_source='schedule'` 填 `triggeredBy='cron'`。词表已有（E1），零词表改动；生产者是 Automation 的 `schedule.cron` 规则，不是第二套调度器。
- **`integration_schedules` 是删还是接管：都不。** 判为 **deprecated，永不接活**（与 minimal-plan §6.1「不接活第二套 `integration_schedules` runtime」一致；§7「不删除历史 migration」禁止 DROP）。它今天零读零写（E10），删表反而要改被 pin 的迁移测试表清单，收益为零。
- **入站 webhook 的准入**：只走 Automation 现有 `webhook.received` 规则（HMAC + 300s 重放窗，E25），插件不新开入站端点。**但该线今天没有事件 id**（E25 全文无 eventId/dedup），没有事件 id 就没有幂等键 —— 因此该 lane 在拿到"调用方必须提供事件 id"这一契约之前，**只允许 dryRun=true**。
- **记录事件的准入**：允许 `record.created/updated` 触发，但同样只允许 dry-run，并靠 §1.3 的第二条唯一约束天然节流（一次导入 500 行只会留下 1 条在飞请求，其余答 `duplicate`）。

---

## 3. 执行面

- **Worker 怎么起**：复用宿主定时器形状（E20），**不起独立进程**。env 开关默认 OFF；可选 Redis leader lock；插件在 activate 时 `integrationRunPort.registerWorker({ name, run })` 交出 body，宿主只管 tick 与选主。理由：独立进程要重新解决配置、凭据、DB 池与发布；而 `context.queue` 是桩（E21），不能承载 durable worker。minimal-plan §6.1 写的"独立 Integration Worker"在本设计里落为"宿主进程内的独立 worker 循环"，语义不变、部署成本低一个数量级。
- **租约与重入**：租约照 E23 的既有原语（acquire=INSERT，过期走 CAS 接管，renew 是 CAS），`scope_key = pipelineId`。claim 是 `UPDATE ... WHERE status='queued'`（照 E19），`rowCount=0` 即他人已取，直接返回。**每页写入前 renew 一次**；renew 匹配 0 行 = 租约被接管 → 立即中止，不覆盖终态（照 E23 的 lease-lost 语义）。
- **进度上报**：每页结束把 `{page, rowsRead, rowsWritten, rowsFailed}` 写进请求行 `progress`，与 renew 合并成同一条 UPDATE。`integration_runs` 行在跑动期间**不动**，避免与 E7 的唯一索引和终态语义纠缠。
- **`cancel_requested` 的语义与生效点**：`POST /run-requests/:id/cancel` 置位（`queued` 直接转 `cancelled`）。生效点**只有一处**：分页 `while` 顶部、`sourceAdapter.read` 之前（E4 的 `:1016` 之后第一条语句）。不在页内逐行检查——一页的写入是一个不可分割单元，半页取消会让 `rowsWritten` 与死信对不上。终态 `cancelled` 词表与 DDL 都已有（E1），零迁移。
- **水位与取消**：`cancelled` 与 `maxPagesReached` **同类，不推进水位**（E5 的判定要显式含 cancelled）。代价是下次重读一段，收益是绝不跳过未读页。
- **卡死 run 的回收**：现状是 4h 阈值 + 只在下次 `runPipeline` 开头调（E6）——意味着崩溃后 4 小时内谁都跑不了。要改，但**单缩阈值会误杀活跃长任务**（E31/E33/E34），因此判据、CAS、扫描范围三件事同刀落地，展开在 **§3.1**。
- **同步 → 异步的兼容策略（取舍）**：
  - (A) 直接把 `POST /run` 改成"入队即 202+requestId"：破坏 E27 的唯一前端调用方（它读 `run/metrics/preview` 渲染结果区），也破坏一切既有脚本。**否决**。
  - (B) `/run` 与 `/dry-run` **语义一字不改**，新增 `POST /pipelines/:id/run-requests` + `GET /run-requests/:id` + `POST /run-requests/:id/cancel`；前端另起一刀迁移。**推荐**。代价是短期两条路径并存——但 E7 的唯一索引保证它们不会双跑；收益是零破坏、可分刀、老调用方不动。
  - (C) `/run?async=1`：一个路由两种返回形状，类型与 OpenAPI 难写，且"把默认值改一下"就能悄悄翻转语义。**否决**。

### 3.1 卡死 run 的回收：判租约、CAS 收口、无租约 run 不进短 TTL 扫描

早稿把阈值从 4h 缩成"租约 TTL × 3"就收笔，这是有洞的：判据没换、竞态没关、扫描范围没圈。三处都要写死。

#### 3.1.1 现状实读（为什么单缩阈值会误杀）

- **判据只有 `started_at`**：`abandonStaleRuns` 先 SELECT 出 `status='running'` 的行（`lib/pipelines.cjs:769-771`），再在 JS 里按 `started_at < now - olderThanMs` 过滤（`:773-776`），阈值默认 4h（`:763-765`）。
- **run 行上没有别的东西可判**：`integration_runs` 建表只有 `started_at`/`finished_at` 两个时间列，没有租约列、心跳列，连 `updated_at` 都没有（`migrations/057:99-117`）；此后对该表只加过 `provenance_events`（`migrations/060_integration_runs_provenance.sql:14-15`）。
- **本设计的续约不落在 run 行上**：租约列在 `integration_run_requests`（§1.3），renew 是请求行/租约行上的 CAS（§3「租约与重入」），跑动期间 `integration_runs` 行按 §3「进度上报」明确**不动**。于是 run 行的 `started_at` 从开跑那刻起就冻住了——它表示"跑了多久"，不表示"还活着没有"。把阈值缩到 TTL×3，一条正常跑几小时、每页都在续约的 run 会被判成 failed。
- **这条误杀不是推演，仓里已有演示**：既有测试把阈值调成 15 分钟，一条 30 分钟前开始、仍在正常 `running` 的 run 就被判 failed（`__tests__/pipelines.test.cjs:640-648`）。缩阈值等于把这条行为搬到生产常见时长上。
- **回收动作不是 CAS**：`db.updateRow(RUNS_TABLE, { status:'failed', ... }, { tenant_id, workspace_id, id })`（`lib/pipelines.cjs:781-789`）的 WHERE 里没有 `status='running'`；SELECT 与 UPDATE 之间那条 run 若已自行终态，这条 UPDATE 照样盖写。
- **完成侧同样没有终态守卫**：`finishRun → updatePipelineRun` 的 WHERE 也是三键等值（`lib/run-log.cjs:108-126`；`lib/pipelines.cjs:682-686`），所以"回收"与"完成"今天是后写者胜。
- **释放唯一索引的链路**：058 的部分唯一索引条件是 `WHERE status = 'running'`（`migrations/058_integration_runs_running_unique.sql:34-36`），应用层 409 前置在 `lib/pipelines.cjs:637-650`。把一条活着的 run 改成 `failed`，索引位当场让出，同 pipeline 的新 run 立刻插得进——误杀的代价不是"少一条记录"，是**允许第二个进程对同一目标并发写**。
- **顺带记一处注释漂移**：`lib/pipelines.cjs:757` 的注释说该函数"on plugin startup or before creating a new run"被调用，但本基线只有 runner 开头那一个调用点（`lib/pipeline-runner.cjs:935-944`，即 E6）；启动扫不存在。刀 3 接 tick 扫描时把这行注释一并改对。

**结论：审阅意见成立。** 缩阈值这一步，必须与下面三件事同刀落地。

#### 3.1.2 回收判定（三个条件同时成立才回收）

1. **扫描从请求表出发，不从 run 表出发**：短 TTL 扫描的候选集是 `integration_run_requests` 里 `status IN ('leased','running')` 且租约已过期的行；run 行只在候选行的 `run_id` 非空时才被动到。反向做法（从 `integration_runs` 扫 `status='running'`）正是今天的形状（`lib/pipelines.cjs:769-771`），它既看不见租约，也看不见"claim 了但还没来得及建 run 行"的那一格。
   run 侧仍需要一个判定字段，给既有 HTTP 路径的 `abandonStaleRuns` 用：**`request_id IS NOT NULL` = 有请求行、有租约，归 worker 的租约回收管，既有 `started_at` 口径不得碰它**；`request_id IS NULL` 覆盖四个同步 HTTP 入口产生的 run（在请求内直跑、不取租约：`lib/http-routes.cjs:5403,5420` 的 `/run`、`:5437,5443` 的 `/dry-run`、`:5673` 的 external-write apply、`:9711` 的 dead-letter replay）以及刀 2 之前的历史行——这两类**不进短 TTL 扫描**，仍按既有 4h 兜底口径处理（保持 E6 的现状语义，不加严也不放松）。`triggered_by` 和 `trigger_source` 都当不了这个判定字段：前者四处硬编码 `'api'`（E3），后者对老行同样是 NULL（§5）。
2. **核实租约确已失效**：读该请求行的 `lease_expires_at`，确认它早于服务器当前时间，且过期时长超过"租约 TTL × 3"。判的是租约到期字段，不是 `started_at`；一条每页续约的长任务，`lease_expires_at` 一直被推到未来，扫描看不到它。
3. **令牌未变**：从读出租约到写回之间，该请求行的租约令牌（`lease_id` + `lease_epoch`）没有变化——由 3.1.3 的 CAS 保证，不靠应用层的时间差判断。

#### 3.1.3 CAS 形状（两步，缺一是竞态）

**① 先收请求侧的租约（权威一步）**

```
UPDATE integration_run_requests
   SET status = 'failed',
       lease_id = NULL, lease_expires_at = NULL,
       error_summary = 'lease expired: reclaimed by worker'
 WHERE id = :requestId
   AND status = 'running'
   AND lease_id = :observedLeaseId
   AND lease_epoch = :observedLeaseEpoch     -- 每次 renew 把它 +1
```

影响行数 = 1 才算回收成功。= 0 表示持有者在"读"与"写"之间续了约（epoch 变了）或自己已进终态：**放弃本轮回收，不碰 run 行，下次 tick 重判**。影响行数从 `RETURNING *` 的行数读（`lib/db.cjs:327-328`），与 E23 的判法同形（`lib/stock-preparation-confirmation-decisions.cjs:866-867`）。

**② 仅在 ① 成功后，才动 run 行**

```
UPDATE integration_runs
   SET status = 'failed', finished_at = now(),
       error_summary = 'abandoned: lease expired'
 WHERE id = :runId
   AND status = 'running'
```

`AND status = 'running'` 是这条语句的 CAS 核心：它挡住"run 自己 finishRun 成了 succeeded/partial，回收又把它盖回 failed"。今天的实现没有这个谓词（`lib/pipelines.cjs:788`），所以这不是"保持现状"，是明确加严，落在刀 3；`abandonStaleRuns` 的既有签名保留，加一个"仅 `request_id IS NULL`"的模式给 HTTP 路径继续用。

**可行性：别在设计里许一个当前 helper 写不出来的 SQL。** 插件 db helper 的 where 只生成等值 / IS NULL（`lib/db.cjs:103-113`），`updateRow` 走的正是它（`:325`）；`gte/lte` 只在 `select` 的 `range` 参数里（`:121-151`、`:170-177`）。也就是说 `WHERE lease_expires_at < now()` 这种比较谓词**当前拼不出来**。三条落法，刀 3 选一条并在 PR 描述里写明：

- **(a) 等值令牌法（首选，零 helper 改动）**：过期与否在"读出来那一刻"用 JS 判（照 E23 的 `expiryMs(current.expires_at) > at.getTime()`，`lib/stock-preparation-confirmation-decisions.cjs:859-861`），把 `lease_epoch` 当乐观并发令牌放进等值 WHERE。renew 相应改成 `SET lease_expires_at = …, lease_epoch = <自己已知值 + 1>`——也全是字面值写入，因为 helper 的 `set` 只接受值、不接受 `col = col + 1` 这类表达式（`lib/db.cjs:321-324`）。
- **(b) 事务 + 行锁**：`db.transaction` 里用 `selectOneForUpdate` 重读租约、判过期、再写（`lib/db.cjs:353-380`、`:205-219`）。本仓已有同形先例：`lib/stock-preparation-handoff-store.cjs:245,366`，理由注释在 `:173`。
- **(c) 给 `buildWhereClause` 加一个受白名单约束的 `lt` 谓词**：动的是本插件共享的 where 构造器，波及面比前两条大一个量级（同一构造器还服务 select/deleteRows/countRows，`lib/db.cjs:170-177,336,343`），除非 (a)(b) 都不够，否则不选。

**一处要绕开的既有形状**：E23 的 renew 只按 `(scope_key, lease_id)` 等值更新 `expires_at`，没有"未过期"前置判（`lib/stock-preparation-confirmation-decisions.cjs:869-878`），而接管路径是"JS 里判过期 → 按 `lease_id` CAS"（`:859-867`）；`lease_id` 在续约时并不更换。于是"持有者在接管者 SELECT 之后、UPDATE 之前续约"这个窗口里，两边可能都自认持有。本设计的 run 回收因此不照抄"只按 lease_id CAS"，而是加 `lease_epoch`（或走 (b) 的行锁）把窗口关掉。是否回头加固备料那条线的原语，见 §9 第 7 条。

**回收后不自动重排队**：请求行落 `failed` 即止，不自动 `queued`+`attempts+1`。崩溃点未知、已写页数未知，自动重跑是在未知写进度上再写一遍；重跑由人或下一次 cron 以**新** `dedupe_key` 发起（R3 的退避形状只用于 `RUNNING_CONFLICT`，不用于租约回收）。

#### 3.1.4 失败模式表

| 场景 | 租约字段状态 | 扫描是否收进候选 | 回收 CAS 结果 | run 行结果 | 058 唯一索引位 |
|---|---|---|---|---|---|
| 长任务正常续约（跑 6h，每页 renew） | `lease_expires_at` 持续被推到 now+TTL | 否（判定 2 不成立） | 不执行 | 保持 `running` | 继续占用（本该占用） |
| 续约丢失（DB 抖动，renew 匹配 0 行，持有者按 lease-lost 语义中止） | 到期后停在过去 | 是 | ① 影响 1 行 | `running → failed` | 让出 |
| 竞态：扫描读到"已过期"，持有者同刻续约成功 | `lease_epoch` 已 +1 | 是（读那一刻看着过期） | ① 影响 0 行 | 不动，仍 `running` | 不让出，下次 tick 重判 |
| 进程死亡（worker 被 kill，没走 finishRun） | 到期后不再变 | 是 | ① 影响 1 行 → ② 命中 `status='running'` | `running → failed` | 让出 |
| 进程死亡但 run 已自行终态（finishRun 成功、更新请求行前崩） | 到期 | 是 | ① 影响 1 行；② 影响 0 行 | 保持 `succeeded`/`partial`，不被盖回 failed | 早已让出 |
| claim 后崩在 startRun 之前（有请求行、无 run 行） | 到期 | 是 | ① 影响 1 行；`run_id` 为空 → 跳过 ② | 无 run 行 | 与它无关；请求侧唯一约束让出 |
| 同步 HTTP run（`/run`、`/dry-run`、external-write apply、replay） | 没有请求行，也没有租约；run 行 `request_id IS NULL` | 否（请求表候选集里根本没有它；run 侧按 `request_id IS NULL` 跳过） | 不执行 | 由既有 4h `started_at` 兜底口径处理 | 由既有路径处理 |

#### 3.1.5 "回收后允许重跑"的前提，写准

058 的部分唯一索引只在 `status='running'` 时生效（`migrations/058:34-36`），因此**只有 ② 那条 CAS 真的影响了 1 行，索引位才被让出来**。① 成功而 ② 影响 0 行时，那条 run 要么已是终态（索引位早就空着），要么被别人改过（这轮不该由回收去让位）。两步 CAS 里有一步影响 0 行，本轮就不宣布"已回收"，也不把重跑当作已获准——重跑的准入依旧是"新请求过 §1.3 的两条唯一约束 + 建 run 时由 058 索引裁决"，回收只负责把一个**确已失效**的占位让开。

#### 3.1.6 阈值口径

短 TTL 扫描量的是"租约过期了多久"，不是"run 跑了多久"，取 **租约 TTL × 3**（连续三次 renew 没落地才判死，容忍两次抖动）。无租约的行保留 4h 现状口径（E6）。两个阈值分属两类对象，不合并成一个数。HTTP 路径原有的 `abandonStaleRuns` 调用保留（`lib/pipeline-runner.cjs:935-944`），但刀 3 起它只对 `request_id IS NULL` 的行生效，免得它拿 `started_at` 去杀一条有租约、正在续约的 worker run。平台侧同类回收只有启动扫、无周期扫（E19 自述的残留缺口），本设计不重复这个坑。

---

## 4. 告警面

- **emit 条件**（`finishRun` 之后、`runPipeline` 返回之前，两处：E4 的 `:1166` 正常路径与 `:1201` 失败路径）：
  ① `status ∈ {failed, partial}` → `integration.run.failed`；② `succeeded` 但本次新增死信 > 0 → 同样发 `integration.run.failed`（"绿着但丢了行"是失败语义）；③ `succeeded` 且 `rowsWritten > 0` 且 pipeline 显式开了 `notifyOnChange` → `integration.run.changed`。dry-run 的"有变化"不在第一刀。
- **values-free 载荷**（键白名单，多一个键即测试红）：`eventId, tenantId, workspaceId, pipelineId, runId, requestId?, status, mode, dryRun, triggerSource, actorId?, rowsRead, rowsCleaned, rowsWritten, rowsFailed, deadLetterCount, consecutiveFailures, durationMs, errorCode?, startedAt, finishedAt`。
  **不含** `errorSummary` 原文、不含任何行值、不含连接/凭据信息。`errorCode` 走码表（G36 的结构化 reason 落地前留空，不塞自由文本）。
- **Automation 侧接两个触发器**：`integration.run.failed` 与 `integration.run.changed`。分成两个而不是一个：绝大多数部署只想订"坏了叫我"，合并会逼每条规则写条件表达式。
- **复用既有动作，零新动作**：`send_webhook`（HMAC 已有，E14）、`send_dingtalk_group_message`、`send_notification`、`send_email`。备料线已经证明了"宿主按 destination id 注入、插件不长钉钉客户端"这条缝可用（`plugins/plugin-integration-core/index.cjs:519`；消费点 `lib/http-routes.cjs:3696-3706`）。
- **分发路径必须显式选**：记录事件线的 durable outbox 对未登记 eventType 是硬错（E26）。因此告警刀要么把两个新事件族登记进 routing manifest 并升版本，要么显式声明只走 legacy in-process EventBus。**推荐前者**（manifest v2 + consumer key `integration-run-trigger`），但它会碰 durable delivery 那条线的既有测试，成本待评（见 §9）。
- **G05 是硬前置（Gate）**：规则驱动的 `send_webhook` 今天不过 `checkWebhookTargetUrl`（E15）。**告警刀不得先于 G05 那一刀合并。** 否则新触发面等于给"cron → send_webhook → 自家 run 路由（明文 token 躺在规则 JSON 里）"这条旁路发一张官方许可证。反过来，G05 的守卫（https-only + 拒 loopback/私网）会顺手让这条旁路失效——**旁路必须先死，端口才有意义**。

---

## 5. 归因：`actor` / `trigger_source` 是必需项

**必需，不是可选。** 三条理由：

1. `integration_runs` 今天没有任何 actor 列（E11），而四个 run 入口把 `triggeredBy` 全写成 `'api'`（E3）——一个值已经吞下了"人点 API / Automation 旁路 / 运维脚本"三种主体。再接一个触发面，`'api'` 会继续吞下"自动化"，运行台账彻底不可归因。
2. 同一插件的大 BOM 作业线**已经**把"谁发起（actor）"与"用谁的凭据读（principal）"分开落盘（E24 的 `:585`）。run 侧不做，就是同一份数据两套归因口径。
3. 告警载荷要带 `actorId`/`triggerSource`（§4）。没有列就得从 `details` JSONB 里刨——那是自由 blob，既不可索引也无法在运行列表里筛"昨晚定时跑的那批"。

最小实现：`integration_runs` 加 `actor_id TEXT`、`trigger_source TEXT`、`request_id TEXT`，全部可空（老行 NULL），不加 CHECK（词表留在应用层），`triggered_by` 语义不动。

`request_id` 还承担第二个角色：它是 §3.1 回收扫描的**租约存在性判定字段**（非空 = 有请求行、有租约、进短 TTL 扫描；NULL = 同步 HTTP run 或刀 2 之前的历史行，留在 4h 兜底口径）。另两列当不了这个判定字段：`triggered_by` 在四个入口硬编码 `'api'`（E3），`trigger_source` 对老行同样是 NULL。因此**刀 2 是刀 3 短 TTL 扫描的硬前置**——没有这一列，回收扫描分不开"有租约的 worker run"与"没租约的同步 run"。

---

## 6. 分刀

| 刀 | 内容 | 量 | 可测不变式 | 去掉守卫哪个测试红（内存变异探针） |
|---|---|---|---|---|
| **刀 0（前置，属 G05）** | 规则驱动 `send_webhook` 接 `checkWebhookTargetUrl`；拒绝落 refusal code | M | 指向 loopback/私网/非 https 的规则一律被拒且不发包 | 摘掉守卫调用 → "rule-driven send_webhook refuses loopback" 红 |
| **刀 1** | `integration_run_requests` 迁移 + 宿主 `createIntegrationRunPortV1` + 按 plugin 名注入 + 只读 `GET /run-requests/:id` + `pipelines.triggerable` 位。**无生产者、无消费者，零行为变化** | M | ① 同 `dedupe_key` 二次 request 回既有 id 且不新插行；② actor 与 tenant 无成员关系 → `refused`，不入队；③ 请求行不含任何凭据列（列名白名单断言） | 去掉唯一索引 → ① 红；把成员校验改成恒 true → ② 红；给表加一个 token 列 → ③ 红 |
| **刀 2** | 归因三列（`actor_id`/`trigger_source`/`request_id`）+ runs 列表按其筛选 | S | 新建 run 必带非空 `trigger_source`；老行 NULL 仍可读 | 让写入路径忽略 `trigger_source` → "run carries its trigger source" 红 |
| **刀 3** | Worker：宿主 tick（env 默认 OFF）+ registerWorker + 租约 + 取消检查点 + progress + `abandonStaleRuns` 移到 tick **并改判租约**（§3.1：判 `lease_expires_at`、两步 CAS、无租约 run 不进短 TTL 扫描）；新增 `POST run-requests` / `cancel`。`/run` `/dry-run` 一字不改 | M | ① 两个 worker 同 tick，只有一个能把同一请求 `queued→leased`；② 置位 cancel 后在下一页开始前停，已写页不回滚，终态 `cancelled` 且水位不推进；③ 租约被接管后原持有者 renew 返回 `held:false` 并中止；④ flag OFF 时无 timer、无查询，行为与刀 2 后相同；⑤ 租约仍在续约的 run（`lease_expires_at` 在未来）不被回收，哪怕 `started_at` 早于阈值；⑥ 回收两步 CAS：令牌被续约改变 → 第一条影响 0 行、run 行不动；run 已自行终态 → 第二条 `WHERE status='running'` 影响 0 行、终态不被盖回 `failed`；⑦ `request_id IS NULL` 的 run 在短 TTL 扫描里零命中 | 去掉 claim 的 `WHERE status='queued'` → ① 红；把取消检查点挪出循环 → ② 红；renew 恒真 → ③ 红；start 忽略 env → ④ 红；把回收判据换回 `started_at` → ⑤ 红；去掉 CAS 的 `lease_epoch` 等值谓词 → ⑥ 前半红；去掉第二条 CAS 的 `status='running'` → ⑥ 后半红；去掉 `request_id IS NOT NULL` 过滤 → ⑦ 红 |
| **刀 4** | 触发面：`run_integration_pipeline` 动作 + CHECK 迁移 + executor 分支（只组装、只调端口、**绝不 fetch**）+ 最小规则编辑 UI | M | ① 配置含 url/headers/token 等未知键 → 保存 400；② 产出的请求 `trigger_source='automation'`、actor=规则 `created_by`，租户由宿主判定；③ `dryRun` 缺省 true；④ 同一 `scheduledFor` 两次到点只入队一次 | 去掉闭集校验 → ① 红；让 executor 读 `config.tenantId` → ② 红；默认值改 false → ③ 红；去掉 `dedupe_key` → ④ 红 |
| **刀 5** | 告警：runner emit 两个事件族 + routing manifest 升版 + Automation 两个触发器 + 载荷 golden | M | ① failed/partial 必发且同一 runId 只发一次；② 载荷无 `errorSummary` 原文、无任何行值（键白名单 golden）；③ 事件族未登记 manifest 时 producer 抛错而非静默零消费者；④ emit 失败不改变 run 终态 | 把 errorSummary 塞进载荷 → ② 红；从 manifest 删该族 → ③ 红；让 emit 的异常外抛 → ④ 红 |

**建议顺序**：刀 0（G05，Gate）→ 刀 1 → 刀 2 → 刀 3 → 刀 4 → 刀 5。
每刀都能独立合并：刀 1/刀 2 是纯新增（无生产者），刀 3 默认 OFF，刀 4 在刀 3 OFF 时只会让请求排队不执行（可观察、不危险），刀 5 依赖刀 3 的终态语义与刀 0 的 Gate。若要压到 4 刀，把刀 2 并进刀 1（同一份迁移）。

---

## 7. 明确不做（引既有裁决）

- **n8n 式可视化画布 / 连接器市场 / 第三方 Connector SDK / 远程 Bridge Agent fleet / BPMN 与 Integration 整合 / AutomationExecutor 与 PipelineRunner 合并**：`docs/integration-consolidation-minimal-plan-20260901.md:315-327`（§6.3 明确延期）与 §4「必须保持两个执行引擎」。
- **任何 K3 Save/Submit/Audit、任何通用外部写回**：K3 外部写四层永久围栏（`plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs:3-11`）+ minimal-plan §6.3 末条；本端口只请求"运行"，永不携带写授权。
- **Bridge 变成写通道 / 远程形态**：Bridge 只作 transport（minimal-plan §5 PR-3），远程 fleet 需 owner ratify。
- **第二套调度 runtime（接活 `integration_schedules`）**：§2 已判 deprecated。
- **节点级重试/退避（G25）、跨管道运行列表 UI（G34）、结构化失败原因（G36）**：本设计只保证它们的落点存在（`errorCode` 字段位、请求行 `attempts`），实现另立。

---

## 8. 风险与反例

| # | 反例 | 缓解 | 对应测试 |
|---|---|---|---|
| R1 | **定时触发让一个失效凭据每小时打一次客户库**，账号被锁、客户 DBA 找上门 | 连续失败熔断：同 pipeline 连续 N 次 `failed` → 入队即 `refused: CIRCUIT_OPEN` 并发一次告警，pipeline 置 `paused`（词表已有，`pipelines.cjs:26`），需人工解除 | 连续 3 次 failed 后第 4 次 request 返回 `refused=CIRCUIT_OPEN` 且**不产生 run 行**、**不建立任何外部连接** |
| R2 | **重放与幂等键碰撞导致双写**：webhook 重投递跑两次；或两条不同 pipeline 的规则共用 ruleId 前缀，第二条被误判为重复而**永不执行**（比双写更隐蔽） | `dedupe_key` 必须含 `pipelineId`；provider 不给事件 id 时**拒绝入队**而不是自己编一个（编 = 每次新键 = 每次都跑；E25 说明该 lane 今天就没有事件 id） | 同键两次 → 一行一 run；同 ruleId 不同 pipeline → 两行两 run；无事件 id 的 webhook lane 请求 → `refused` |
| R3 | **Worker 与 HTTP 并发跑同一 pipeline**：用户点了"立即运行"，同一分钟 cron 也到点 | DB 层已有 partial unique index 兜底（E7）；worker 遇 `RUNNING_CONFLICT` **不算失败**：请求退回 `queued`、`attempts+1`、`not_before=now+backoff`；HTTP 侧 409 语义原样保留 | 先起一个挂起的 HTTP run，worker tick 同 pipeline → 请求仍 `queued`、`attempts=1`、**无第二条 run 行**、无 409 抛给用户 |
| R4 | **取消造成水位漂移**：第 5 页取消，前 4 页已写；若按 `rowsFailed===0` 推进，第 5 页之后的数据永远漏读 | `cancelled` 与 `maxPagesReached` 同类，不推进水位（E5 判定显式含 cancelled） | 取消后 `integration_watermarks` 行未变；下一次 incremental 从原水位重读 |
| R5 | **告警风暴**：一条坏 pipeline 每 5 分钟失败一次 → 每 5 分钟一条钉钉 | 载荷带 `consecutiveFailures` 供规则侧写条件；R1 的熔断本身即是最终节流 | 熔断后不再产生新事件（第 4 次起零 emit） |
| R6 | **worker 多副本重复执行**：多实例部署下两个进程同时 tick | 可选 Redis leader lock（E20 同款）+ claim 守卫（E19）+ 租约 CAS（E23）三层，任一层单独成立即不双跑 | 无 leader lock 时两 worker 并发 claim 同一请求 → 恰好一个成功 |
| R7 | **活跃长任务被误回收**：阈值从 4h 缩到租约 TTL×3 后，一条正常跑 6 小时、每页都在续约的 run 被按 `started_at` 判成 failed（E31/E33；同形行为已由 `__tests__/pipelines.test.cjs:640-648` 演示）。它一失败就让出 058 的部分唯一索引（`migrations/058:34-36`），同一 pipeline 于是被允许重跑，两个进程并发写同一目标 | §3.1：回收判 `lease_expires_at`（不判 `started_at`）+ 两步 CAS（请求侧 `lease_epoch` 令牌 + run 侧 `status='running'`）+ `request_id IS NULL` 的同步 run 不进短 TTL 扫描 | 续约中的 run 扫描零回收；令牌在读与写之间变化 → 回收影响 0 行且 run 仍 `running`；已 `succeeded` 的 run 不被盖回 `failed`；`request_id IS NULL` 的 run 在短 TTL 扫描里零命中 |

---

## 9. 待裁决与不确定点

1. **routing manifest 升 v2 还是只走 legacy in-process**（§4）。推荐 v2，但会碰 durable delivery 线的既有测试与版本集合（`SUPPORTED_MANIFEST_VERSIONS`，E26），成本未评估。
2. **`record.created/updated` 要不要允许作为触发源**。本稿建议允许但仅 dry-run；若 owner 认为"记录事件驱动外部拉取"本身就该禁，删掉即可，不影响其余各刀。
3. **cancel 后是否推进已完成页的水位**。本稿选保守（不推进）；若客户抱怨重复读量，可改为"按已完成整页推进"，但那需要 runner 保留 per-page 水位快照，属另一刀。
4. **`triggerable` 位放 pipeline 行还是另起申报表**。本稿选前者（避免两套真相）；若将来要做"按角色授权可触发范围"，需要重新评估。
5. **worker 用宿主 tick 还是插件自起 setInterval**。本稿选宿主（leader lock 与 shutdown 钩子已有，E20）；插件自起会在多副本部署下没有选主。
6. **W4 硬门（E29）默认 OFF 时的口径**。本端口的租户判定走宿主 `user_orgs` 成员关系，不依赖 `req.user.tenantId`，因此不受该开关影响；但既有 `/run` 路由仍受影响，两条路径的租户口径在 W4 打开前不完全一致，需在刀 3 的验收里显式记录。
7. **是否回头加固 E23 的租约原语**（§3.1.3）。它的 renew 没有"未过期"前置判、接管 CAS 只认不随续约变化的 `lease_id`（`lib/stock-preparation-confirmation-decisions.cjs:869-878`、`:859-867`），"持有者在接管者 SELECT 之后续约"这个窗口里两边可能都自认持有。本设计的 run 回收用 `lease_epoch`（或事务内行锁，E37）避开该形状；备料确认线是否同样加固属另一刀，其既有测试成本未评估。
8. **§3.1.3 的三条落法选哪条**（(a) 等值令牌 / (b) 事务+行锁 / (c) 扩 helper 的 `lt` 谓词）。本稿倾向 (a)：零 helper 改动、与 E23 同形；但 (a) 依赖 renew 与回收共用 `lease_epoch` 递增口径，若刀 3 实现时发现 renew 与进度上报合并成一条 UPDATE 后 epoch 语义变绕，改走 (b) 也可接受，需在 PR 里写明选了哪条。
