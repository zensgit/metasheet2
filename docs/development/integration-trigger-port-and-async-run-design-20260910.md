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

列：`id`、`tenant_id`、`workspace_id`、`pipeline_id`、`mode`、`dry_run`、`trigger_source`、`trigger_ref`、`requested_by`、`dedupe_key`、`status`、`cancel_requested`、`progress JSONB`、`lease_id`、`lease_expires_at`、`attempts`、`not_before`、`run_id`（→ `integration_runs.id`，可空）、`refusal_code`、`error_summary`、`created_at`、`updated_at`。

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
- **卡死 run 的回收**：现状是 4h 阈值 + 只在下次 `runPipeline` 开头调（E6）——意味着崩溃后 4 小时内谁都跑不了。改为：worker 每次 tick 先扫一遍，阈值改为 **租约 TTL × 3**（不再是 4h），且 run 与 request 两侧同时回收；HTTP 路径原有调用保留（幂等）。平台侧同类回收只有启动扫、无周期扫（E19 自述的残留缺口），本设计不重复这个坑。
- **同步 → 异步的兼容策略（取舍）**：
  - (A) 直接把 `POST /run` 改成"入队即 202+requestId"：破坏 E27 的唯一前端调用方（它读 `run/metrics/preview` 渲染结果区），也破坏一切既有脚本。**否决**。
  - (B) `/run` 与 `/dry-run` **语义一字不改**，新增 `POST /pipelines/:id/run-requests` + `GET /run-requests/:id` + `POST /run-requests/:id/cancel`；前端另起一刀迁移。**推荐**。代价是短期两条路径并存——但 E7 的唯一索引保证它们不会双跑；收益是零破坏、可分刀、老调用方不动。
  - (C) `/run?async=1`：一个路由两种返回形状，类型与 OpenAPI 难写，且"把默认值改一下"就能悄悄翻转语义。**否决**。

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

---

## 6. 分刀

| 刀 | 内容 | 量 | 可测不变式 | 去掉守卫哪个测试红（内存变异探针） |
|---|---|---|---|---|
| **刀 0（前置，属 G05）** | 规则驱动 `send_webhook` 接 `checkWebhookTargetUrl`；拒绝落 refusal code | M | 指向 loopback/私网/非 https 的规则一律被拒且不发包 | 摘掉守卫调用 → "rule-driven send_webhook refuses loopback" 红 |
| **刀 1** | `integration_run_requests` 迁移 + 宿主 `createIntegrationRunPortV1` + 按 plugin 名注入 + 只读 `GET /run-requests/:id` + `pipelines.triggerable` 位。**无生产者、无消费者，零行为变化** | M | ① 同 `dedupe_key` 二次 request 回既有 id 且不新插行；② actor 与 tenant 无成员关系 → `refused`，不入队；③ 请求行不含任何凭据列（列名白名单断言） | 去掉唯一索引 → ① 红；把成员校验改成恒 true → ② 红；给表加一个 token 列 → ③ 红 |
| **刀 2** | 归因三列（`actor_id`/`trigger_source`/`request_id`）+ runs 列表按其筛选 | S | 新建 run 必带非空 `trigger_source`；老行 NULL 仍可读 | 让写入路径忽略 `trigger_source` → "run carries its trigger source" 红 |
| **刀 3** | Worker：宿主 tick（env 默认 OFF）+ registerWorker + 租约 + 取消检查点 + progress + `abandonStaleRuns` 移到 tick；新增 `POST run-requests` / `cancel`。`/run` `/dry-run` 一字不改 | M | ① 两个 worker 同 tick，只有一个能把同一请求 `queued→leased`；② 置位 cancel 后在下一页开始前停，已写页不回滚，终态 `cancelled` 且水位不推进；③ 租约被接管后原持有者 renew 返回 `held:false` 并中止；④ flag OFF 时无 timer、无查询，行为与刀 2 后相同 | 去掉 claim 的 `WHERE status='queued'` → ① 红；把取消检查点挪出循环 → ② 红；renew 恒真 → ③ 红；start 忽略 env → ④ 红 |
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

---

## 9. 待裁决与不确定点

1. **routing manifest 升 v2 还是只走 legacy in-process**（§4）。推荐 v2，但会碰 durable delivery 线的既有测试与版本集合（`SUPPORTED_MANIFEST_VERSIONS`，E26），成本未评估。
2. **`record.created/updated` 要不要允许作为触发源**。本稿建议允许但仅 dry-run；若 owner 认为"记录事件驱动外部拉取"本身就该禁，删掉即可，不影响其余各刀。
3. **cancel 后是否推进已完成页的水位**。本稿选保守（不推进）；若客户抱怨重复读量，可改为"按已完成整页推进"，但那需要 runner 保留 per-page 水位快照，属另一刀。
4. **`triggerable` 位放 pipeline 行还是另起申报表**。本稿选前者（避免两套真相）；若将来要做"按角色授权可触发范围"，需要重新评估。
5. **worker 用宿主 tick 还是插件自起 setInterval**。本稿选宿主（leader lock 与 shutdown 钩子已有，E20）；插件自起会在多副本部署下没有选主。
6. **W4 硬门（E29）默认 OFF 时的口径**。本端口的租户判定走宿主 `user_orgs` 成员关系，不依赖 `req.user.tenantId`，因此不受该开关影响；但既有 `/run` 路由仍受影响，两条路径的租户口径在 W4 打开前不完全一致，需在刀 3 的验收里显式记录。
