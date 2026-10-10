# 任务功能 M4 后端 PR-3b 设计（草案修订 7，2026-10-09；初稿 2026-10-01）

> **状态：DRAFT。** 本件叠在**尚未合并**的 PR-3a（Draft #6266，分支 `claude/tasks-m4-pr3a`）之上，只能在它之后合并。M3 后端已随 #6229 合入 main；任务 D 的纯函数模块随 PR-3a 进入本栈（任务 D 自己是 Draft #6186）。S0–S1 从 PR-3a 当时的 head 起；S2 起叠在已含 PR-3a S5–S9 的 head 上；收口时 PR-3a 的最终 head 与本分支已含的 PR-3a 内容逐字节相同（入口条件与重叠步骤见 §14，S7 的记录在验证 MD）。owner 在 2026-10-07 经 M4 回复模板对裁决包落槌（R01–R23、N1、N2）；本 PR 收到的已裁条目（§12 逐条列明）在代码与本文里标 `RULED(2026-10-07)`，2026-10-09 另裁一条正文文案规则（§8.3，标 `RULED(2026-10-09)`）；其余取值仍标 `ASSUMPTION(task-m4)`（包内默认约束标 `[Dxx]`，本件自选标 `[own-3b-NN]`）。裁决不授权合并、DDL 应用或打开开关：**不合并、不上 staging、不应用任何 DDL；三个 flag 默认 OFF，不在任何环境打开任何 `TASKS_*` 开关**。裁决包是私有件，本文只按条目 id 引用，不引原文。

- **修订 1**：合规、并发与可靠性、安全与运维三个视角的评审共 34 条，逐条对源码核实后处置，结果见 §16；三个评审者全部返回，没有缺席。正文已按处置改过。
- **修订 2（S2 入口，2026-10-08）**：按 §14.0 重叠到 PR-3a 的 head `d940fa8745`（含 S5–S10）之后重核了本文按名字引用的符号与行号（§4.3 改为该 head 的行号）；§5.3 关于 `task_list_items` 的陈述按 PR-3a S7 的表形更正（该表现有 `org_id` 列与两条组合外键）；§11.3 他 org 清单格的播种方式随之更正；§12 / §13 按 2026-10-07 的裁决改写（已裁 / 仍为假设分列，新增 §13-Q21）；N1 已裁，S3 不再可去掉（§5.5、§14）。取值未改。
- **修订 3（S4 入口，2026-10-08）**：R01、R04、R13 都在 2026-10-07 的裁决之内（回复模板对 R02–R23 的批准含 R04、R13，模板末句含 R01），本件改标 `RULED(2026-10-07)`，§13-Q21 关闭；R01 已定门号，§13-Q10 只剩落锁一事；R04 只覆盖 `buildTaskByIdCondition`，本件新增的 `buildTaskByIdAnyStateCondition` 仍是自选（`[own-3b-17]`，§13-Q14 未答）；R13 的措辞改为它裁定的内容（M4 不做硬删，保留期另行裁定），「账本行在 M4 里一直保留」是它的结果，不是裁决原文。取值未改。
- **修订 4（S2–S6 门审修复，2026-10-09）**：停机时 worker 立即退还本批尚未开始的行，不等在飞的那一行（§6.6、§7.2）；leader 会话由服务端 `idle_in_transaction_session_timeout` 限界、扫描在每页之前心跳（§4.2、§6.1，`[own-3b-35]`）；每行预算与超预算时其余行的立即退还（§7.2、§7.5，`[own-3b-36]`）；物化先于 `prepare`、栅栏前再物化一次（§3.3、§7.4，`[own-3b-37]`）；汇总扫描按发送时的在职判据过滤（§6.3，`[own-3b-38]`）；interval 上限改为 W/2，构造函数校验而不夹取（§6.2、§9.1，`[own-3b-39]`）；钉钉通道的错误文本先截后处理、脱敏规则加宽、token 获取在通道内与预算竞速、传输层不记本通道调用的上游原文（§8.2、§8.5、§10，`[own-3b-40]`）；正文里的用户文本把 `:` 渲染为 `：`（`RULED(2026-10-09)`，§8.3）；§3.1 的 producer 合同按实现改写；§12 补齐 `[own-3b-26]`…`[own-3b-40]`；§13 新增 Q23、Q24。取值变化只有 interval 上限（7 200 000 → 3 600 000）与新增的常量。
- **修订 5（S7 收口，2026-10-09）**：§3.2 / §3.3 的合同按实现改写：tick 的第五种结果（`[own-3b-30]`）、两个导出的扫描与它们的选项（`[own-3b-32]`）、投递 job 与启动函数的选项（`[own-3b-33]`）、`prepare` 收到投递 id、worker 的开关（`[own-3b-26]`）与两张固定码表、通道导出的辅助项；§3.1 补上唯一的 INSERT 函数；§4.1 写明积压 gauge 的口径（`[own-3b-31]`）；§8.1 写明注册只看开关；§8.5 写明 `last_error` 的格式（`[own-3b-34]`）；§11.1、§11.7 两处按修订 4 之后的实现更正；§11.0 与 §13-Q10 点名只改锁的 Draft PR #6248；§12 的 `[own-3b-08]` 改为 interval 夹到 `[5 s, W/2]`，`[R18]` 补进只引用的一行；§13 按当前状态复核；§14 S7 的 PR body 清单按实现改写。取值未改。
- **修订 6（S7 之后的再门审修复，2026-10-09）**：两个扫描在一页之内每再读一组至多 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS`（50）个 org 的按 org 读之前再心跳一次，先心跳、再看 stopping / lost（§3.2、§4.2、§6.1、§6.2、§6.3，`[own-3b-35]`）；worker 在 `prepare` 之前与再物化之前也看 stopping，在飞的行在最近的检查点退还（§6.6、§7.2）；每行预算 = prepare 预算 + 物化余量，严格大于 prepare 预算，三处预算检查各自的规则写明（§7.2、§12 `[own-3b-08]` `[own-3b-36]`）；钉钉通道的值表加入 agent id，两次截断都不落在代理对中间，脱敏的已知限制按规则列出（§8.5，`[own-3b-40]`）；§6.2 的 W/2 陈述改为它给出的实际界；§8.4、§8.5 只写规则。取值变化：prepare 预算 15 s → 12 s（新增物化余量 3 s；每行预算、每行预留与租约不变），新增常量 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS` = 50。
- **修订 7（改叠，2026-10-09）**：PR-3a 把 M4 迁移重新定名为 `zzzz20261009130000_create_task_m4_tables`，本件改叠到重新定名之后的 PR-3a：§2 写现名，manifest 三个开关的 `purpose` 同步；本件新增的生产源码注释不点名其他线的表（门 15，producer 与钉钉通道各有注释改写，只改注释）；下面「范围来源」一条引用裁决只写范围与条目 id，不写裁决包的章节号；§5–§6 引 `task-reminders.ts` 的六处行号按改叠后的文件改正（PR-3a 改写注释之后该文件短了 13 行，改叠之前这几处就差 1–2 行）。取值、规则、代码都没有变。改叠的记录见验证 MD「2026-10-09 改叠到重新定名之后的 PR-3a」一节。
- **入库**：本文随 PR-3b 的 S0 入库（2026-10-07，路径 `docs/development/task-m4-pr3b-backend-design-20261001.md`）；S0 的实际基座 SHA 与各片的结果记在 `docs/development/task-m4-pr3b-backend-verification-20261001.md`，不钉在本文。入库时只改了抬头与若干措辞，没有改任何取值。
- **范围来源**：裁决包给 PR-3b 划定的范围（按条目 id 引用）：通知账本的写入方、自建调度器（每个 tick 取 leader 锁，跑提醒扫描与汇总扫描）、投递 worker、钉钉通道、三个默认关闭的开关与各自的 manifest 条目、候选门 M4-a…M4-d。另回答 PR-3a 设计 §12-Q4：N1 放哪一个 PR（§13-Q1，本件建议放 PR-3b）。
- **不做**：socket / realtime handler 改动（PR-3c）；任何前端；PR-3a 已拥有的一切（路由、清单、分组、设置、分页、日期写入）。
- **基座**：S0 从 PR-3a 分支在动手那一刻的 HEAD 起，实际 SHA 记进验证 MD，不钉在本文。修订 1 重核的 PR-3a 状态（2026-10-01）：HEAD `aafa05f2d5`；S4 已提交（`acd3846799`）；S5 在工作树里尚未提交（`task-list-access.ts`、`task-list-records.ts` 未跟踪）；S6–S10 未开始。本文按**名字**引用 PR-3a S5/S6 才会提供的符号（`buildTaskListByIdCondition`、清单归档 handler、`task-org-members.ts#findActiveOrgMembers`），这些名字与本文引用的全部 PR-3a 行号都在 S2 入口时**重核**。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`。本件相关条款：§4.2（outbox 三条索引）、§4.3（org 来源）、§4.4（日期与时区）、§6.4（`tasks-scheduler:leader` 键与取锁形式；持 leader 锁的事务里不再取结构锁或投影锁）、§10（三个 P1 flag 默认 OFF；manifest 义务）、§12 门 7 / 14 / 15 / 17 / 18 / 20、§13-19 / §13-7 / §13-13。
- **纯函数来源**：任务 D 的 `task-reminders.ts`、`task-notifications.ts`、`task-settings.ts`、`task-realtime.ts`（后者 PR-3c 用），任务 B 的 `task-access.ts` / `task-dates.ts` / `task-lock-keys.ts`，任务 C 的 `task-membership.ts`。服务层只调用，不另写规则（门 20）。本件补的纯函数全部放在 `src/tasks/`（§4.1）。
- **仓库守卫**：新 `task-*.db.test.ts` 三处登记（`vitest.config.ts` exclude 字面量、`.github/workflows/tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off` import），由 `task-ci-coverage-enumeration.test.ts` 强制；三个 flag 的 manifest 条目由 `global-history-flag-manifest.test.mjs:178` 的 `TASKS_[A-Z_0-9]+`+`_ENABLED` 发现式核对强制（源码里出现即要登记，含注释）。

---

## 1. 范围

**做**（PR-3b）：

1. **outbox producer**：在写入 `task_events` / `task_list_events` 的同一事务里，按任务 D 的收件人网格把通知意图写成 `task_notification_deliveries` 行；`ON CONFLICT (org_id, source_key) DO NOTHING` 幂等；只为有活跃钉钉集成的 org 写行（§5）。
2. **`TaskScheduler`**：自建的周期循环；每个 tick 在一个专用连接的独立事务里经 `acquireTasksSchedulerLeaderLock` 取 `tasks-scheduler:leader`，取到才跑单任务提醒扫描与每日汇总扫描；提交（释放锁）之后，本 tick 的 leader 再跑一段有时间预算的投递循环（§6）。
3. **delivery worker**：claim / 租约 / 效果栅栏（栅栏同时把租约续到恰好覆盖一次发送）/ 终态 CAS / 未处理行退还 / 过期清扫；每条 outbox 行的外部发送**至多发起一次**（§7）。
4. **钉钉通道**：复用 `integrations/dingtalk/client.ts` 的 `sendDingTalkWorkNotification` 与 `fetchDingTalkAppAccessToken`，并给两者传任务线自己的超时常量；收件人身份经 org 限定的目录三表 join 解析，发送用的应用配置**只取产生该身份的那一行集成**；只在其 flag 严格等于 `'true'` 时注册（§8）。
5. **三个 flag**：`TASKS_SCHEDULER_ENABLED`、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED`、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED`，默认 OFF，同 PR 补 `scripts/ops/global-history-flag-manifest.mjs` 条目（§9）。
6. **N1**（`RULED(2026-10-07)`）：`all` 模式下，负责人的增删让任务完成或重启时，在同一事务里追加 `completed` / `reopened` 事件，actor 为操作者（改任务 C 的 `task-membership.ts`，§5.5、S3）。
7. **门**：候选门 M4-a（outbox 幂等与形状）、M4-b（收件人集合）、M4-c（提醒与每日汇总）、M4-d（调度单实例）；门 18 的 M4 子集（三个 flag）；门 1 / 17 / 20 / 15 的新表面子集（门 1 为 worker 物化的第二租户格）。行名按 R01（`RULED(2026-10-07)`，推荐值的修订形）落在整数门号上（§11.0）；这些新行要由一个只改锁的 PR（Draft #6248）写进锁，那个 PR 合并之前一律候选、未计分。

**不做**：

| 不做的事 | 去向 / 理由 |
|---|---|
| socket `tasks:counts-updated` 与 M2/M3 handler 的 emit 回改；最终 head 上 `M2\|` / `M3\|` 全部门行的回归重跑 | PR-3c |
| 任何前端（设置页、徽标订阅、通知文案） | FE-a/b/c |
| 新 HTTP 路由（例如 outbox 账本的管理接口、手工重投接口、通知偏好接口） | 裁决包没有列；`redelivery_safe` 只写不读（§7.6） |
| 任何 DDL（§2）；outbox 行的保留期与清理作业 | `RULED(2026-10-07): [R13]`：M4 不做硬删，保留期另行裁定；所以在 M4 里账本行一直保留，清理作业另开切片 |
| 附件通知 `attachment_added`；`assignee_added` 通知（R05-opt） | P2；R05-opt 默认不含，采纳时只改任务 D 的 `TASK_NOTIFIABLE_EVENTS` 字面量 |
| 免打扰时段、deep link actionCard、企业微信 / 邮件通道 | 考勤线的东西；裁决包与锁都没有给任务线这些能力 |
| 每日汇总的发送时刻可调、`remind_at` 的到期时刻多次提醒 | R07 固定 09:00；R06 单次 |
| 把三个 flag 加进 staging window-runner 的输入 | 共享 workflow，PR-3b 只许改 `tasks-realdb.yml`；见 §9.4 |

`TASKS_ENABLED` 语义不变。三个新 flag 都在它之下（§9.1）。

---

## 2. 表与迁移

**本 PR 不新增迁移，不改任何列。** PR-3a 的 `zzzz20261009130000_create_task_m4_tables.ts`（PR-3a S1–S9 时名为 `zzzz20261001090000_create_task_m4_tables.ts`，S10 改名为 `zzzz20261008090000_create_task_m4_tables.ts`，2026-10-09 再次改名为现名；本件在 S2 入口的重叠里同步了全部引用，2026-10-09 随 PR-3a 的再次改名同步了 manifest 的三段 `purpose`；迁移正文与行数都没有变，下列行号照旧）已经建全本件需要的一切：

- `tasks.remind_at timestamptz` 与部分索引 `idx_tsk_remind (remind_at) WHERE remind_at IS NOT NULL`（`:59-64`）：提醒扫描按 `remind_at` 区间取行，谓词只到非空，符合 PR-3a `[own-26]`。本件不收窄它。
- `task_notification_deliveries`（`:240-293`）：`org_id NOT NULL` 无默认值；`status` 七值含 `outcome_unknown`；`recipient_role` 四值；`attempt_count` / `next_attempt_at` / `last_attempt_at` / `claimed_at` / `claim_expires_at` / `claim_worker_id` / `delivered_at` / `last_error` / `payload` / `redelivery_safe`；唯一索引 `uq_tskn_source_key (org_id, source_key)`；`idx_tskn_claim (status, next_attempt_at)`、`idx_tskn_reclaim (status, claim_expires_at)`、`idx_tskn_source (org_id, source_type, source_id)`；`delivered_at IS NULL OR status = 'sent'`。
- `task_user_settings.time_zone` 与 CHECK `daily_reminder_enabled = false OR time_zone IS NOT NULL`（迁移 `:215-238`，与 PR-3a 设计同形）：每日汇总的收件人与时区来源。
- `task_events` 的 `idx_tske_task_time (task_id, occurred_at DESC)`（P0-A）：提醒扫描的 floor 子查询用它。

**被拒绝的 DDL 候选**（写明，供实现时对照）：

| 候选 | 为什么不建 |
|---|---|
| 给 outbox 加一列效果栅栏（e-learning 线的做法：`zzzz20260908160000_add_elearning_notification_dispatch_fence.ts:24-26` 加 `dispatch_state` 四值列并配触发器） | 本件用既有 `status` 表达同一个栅栏：`sending` 只在网络调用**之前那一刻**才写入（§7.2）。既有列够用，不为此开一条只加列的迁移（PR-3a `[own-22]` 的理由：只加列的迁移无法被 staging 的表缺席证明覆盖） |
| `task_user_settings(daily_reminder_enabled)` 的部分索引 | 每日汇总每 tick 全表扫这张小表；P1 规模下不需要 |
| 收窄 `idx_tsk_remind` 的谓词到 `status='open' AND deleted_at IS NULL` | 扫描 SQL 自带这两个条件；索引只按 `remind_at` 范围取候选，收窄属优化，留给有量之后 |
| 状态机触发器（禁止非法状态迁移） | 本件靠 CAS 子句（§7.2）；触发器是加固项，随 owner 对 §13-Q2 的答复再议 |
| claim 用的部分索引 `(next_attempt_at, created_at) WHERE status IN ('pending','retrying')` | PR-3b 不做 DDL；在账本以终态行为主时，claim 经 `status` 索引只读到期行，代价与到期积压成正比（§7.2 的执行计划）；作为给 PR-3a 的可选建议（§13-Q17），不是前提 |

因此门 14（含 DDL 的 PR 首段声明）对本 PR 不适用；PR body 仍要写明「本 PR 无 DDL；依赖 PR-3a 的迁移已应用于任何打开 `TASKS_ENABLED` 的环境」（PR-3a §9.2 的耦合陈述照抄一次）。

---

## 3. 合同（无新 HTTP 路由）

PR-3b 不增加、不改变任何 HTTP 路由或响应形状。下面是四个内部合同，前端与 PR-3c 都不依赖它们。

### 3.0 共性

- 所有新代码只经 `req.authenticatedTenantId` 已经落到行里的 `org_id` 工作：producer 从调用它的 handler 拿 `orgId`；调度扫描从 `tasks.org_id` / `task_user_settings.org_id` 拿；worker 从 outbox 行拿。没有任何一处回退到 `'default'`。
- 时间：纯函数全部接受显式 `now`；生产运行时的 `now` 由每个 tick 开头一次 `SELECT now()` 锚定（§6.5）；测试注入固定或步进的时钟，**没有 sleep**。
- 日志：只写 id、计数、状态码、固定错误码；不写标题、正文、token、钉钉返回原文（原文经 §8.5 的脱敏与截断后才进 `last_error`）。
- 三个 flag 都是严格等于 `'true'`（与 `TASKS_ENABLED` 同一口径），读点在 `src/services/task-notification-flags.ts`（§9.1），循环类在启动时读，producer 在调用时读；进程运行期不改 env，两者一致。

### 3.1 producer

```ts
// src/services/task-notification-producer.ts
export interface WrittenTaskEvent { id: string; type: string; actorId: string; occurredAt: Date | null }
export async function enqueueTaskEventNotifications(db: Db, input: {
  orgId: string; taskId: string; createdBy: string
  events: WrittenTaskEvent[]
}): Promise<number>                        // 写入的行数（冲突的不计）；负责人 / 关注人 / 清单成员由 producer 在写入之后、调用方的连接上读出（写后集合，§5.3）
export async function enqueueTaskListEventNotifications(db: Db, input: {
  orgId: string; listId: string; listCreatorId: string; actorId: string
  event: { id: string; type: string }
}): Promise<number>
export async function resolveTaskDeliveryChannelsForOrg(db: Db, orgId: string, names: TaskNotificationChannel[]): Promise<TaskNotificationChannel[]>
export async function insertTaskNotificationDeliveries(db: Db, plans: TaskNotificationDeliveryPlan[]): Promise<number>
                                           // outbox 唯一的 INSERT 文本；两个扫描也经它写行（§5.4）
```

- 两个函数都在调用方的事务里跑（`db` 是持锁的 client）。
- 事件类型不在 `TASK_NOTIFIABLE_EVENTS`（`task-notifications.ts:29`）内的直接跳过；清单事件只有 `archived` 产生通知（`task-notifications.ts:134-140`）。
- `resolveTaskDeliveryChannelNames()` 为空（投递线未全开，§9.1）时**不发任何查询、不写任何行**，直接返回 0。
- 非空时先调 `resolveTaskDeliveryChannelsForOrg(db, orgId, names)`（`task-notification-producer.ts` 内，一条 `EXISTS` 查询）：钉钉通道只在该 org 有 `provider='dingtalk' AND status='active'` 的 `directory_integrations` 行时保留（`ASSUMPTION(task-m4): [own-3b-13]`，§5.1）；结果为空同样返回 0，不读收件人、不写行。

### 3.2 scheduler

```ts
// src/services/task-scheduler.ts
export interface TaskSchedulerJobContext {
  now: () => Date                              // 本 tick 的时钟：tick 开头读一次数据库时钟，随单调时钟前进（§6.5）
  stopping: () => boolean; leaderLost: () => boolean
  stopSignal?: AbortSignal                     // stop() 把它 abort；投递循环凭它立即退还未开始的行（§6.6）
  leaderHeartbeat?: () => Promise<void>        // leader 连接上的一条语句；扫描在每页之前、页内每再读一组 org 之前调用（§6.1）
}
export interface TaskSchedulerJob { name: string; run(ctx: TaskSchedulerJobContext): Promise<unknown> }
export interface LeaderClient { query(sql: string, params?: unknown[]): Promise<unknown>; on(ev: 'error', fn: (e: Error) => void): unknown
  removeListener(ev: 'error', fn: (e: Error) => void): unknown; release(err?: Error | boolean): void }
export class TaskScheduler {
  constructor(options: {
    scanJobs: TaskSchedulerJob[]                 // 持 leader 锁期间跑：提醒扫描、汇总扫描
    deliveryJob?: TaskSchedulerJob | null        // 提交释放锁之后，只由本 tick 的 leader 跑（§6.4）
    connectLeaderClient: () => Promise<LeaderClient>   // 生产：db/pg.ts 的 pool.connect()
    intervalMs?: number                          // 整数且在 [5 000, W/2] 内，否则抛 TypeError（§6.2）
    lockTimeoutMs?: number; leaderIdleTimeoutMs?: number   // 缺省 1 000 / 30 000（§6.1）
    stopGraceMs?: number                         // 缺省 8 000（§6.6）
    logger?: Logger; leaderStateGauge?: LeaderGauge | null; backlogGauge?: BacklogGauge | null
    readNow?: () => Promise<Date>                // 缺省：连接池上的 SELECT now()
    query?: Q                                    // 积压刷新的语句函数，缺省 db/pg.ts 的 query
    monotonic?: () => number                     // 锚定时钟的单调源，缺省 performance.now
  })
  start(): void
  stop(): Promise<void>                    // abort 停机信号；等在飞 tick 收尾，最多 stopGraceMs
  runTick(): Promise<{ leader: boolean; reason?: 'lock_busy' | 'running' | 'stopping' | 'leader_client_lost' | 'leader_unavailable'; jobs?: Record<string, unknown> }>
}
export function createDbAnchoredClock(dbNow: Date, monotonic?: () => number): () => Date
export interface TaskScanJobOptions { query?: Q; env?: NodeJS.ProcessEnv; logger?: Logger
  pageSize?: number                            // 提醒扫描的页大小，[1, 500]，缺省 500（[own-3b-32]）
  heartbeatOrgs?: number }                     // 一次心跳覆盖的按 org 读的 org 数，[1, 50]，缺省 50（§6.1，修订 6）
export function runTaskReminderScan(ctx: TaskSchedulerJobContext, options?: TaskScanJobOptions):
  Promise<{ ran: boolean; pages: number; candidates: number; due: number; written: number }>
export function runTaskDailyDigestScan(ctx: TaskSchedulerJobContext, options?: TaskScanJobOptions):
  Promise<{ ran: boolean; settings: number; due: number; written: number; invalidZone: number; inactiveMember: number }>
export function resolveTaskReminderJob(options?: TaskScanJobOptions): TaskSchedulerJob
export function resolveTaskDailyDigestJob(options?: TaskScanJobOptions): TaskSchedulerJob
export function resolveTaskNotificationDeliveryJob(options?: { env?; channels?; query?; workerId?; budgetMs? }):
  TaskSchedulerJob | null                      // TASKS_ENABLED 与 worker flag 都为 'true' 才不为 null
export function startTaskScheduler(options?: { env?; pool?; logger? }): TaskScheduler | null
                                               // TASKS_ENABLED 与调度 flag 都为 'true' 且 pool 非 null 才构造并 start()
export function stopTaskScheduler(): Promise<void>
```

修订 5 按实现补记：

- `runTick()` 的五种结果：`lock_busy`（等锁超时，`55P03` / `57014`）、`running`（本实例上一个 tick 还在飞）、`stopping`（`stop()` 之后）、`leader_client_lost`（leader 连接出错：在等锁时、扫描期间或心跳时，或提交失败）、`leader_unavailable`（`ASSUMPTION(task-m4): [own-3b-30]`：读不到数据库时钟、取不到客户端，或 leader 事务自己的语句因等锁以外的原因失败；这个 tick 不是 leader、什么都不跑，gauge 置 `follower`，已取到的客户端销毁）。
- 两个扫描另作为函数导出，返回 `ran`（投递线未全开时为 `false`，且不发任何语句）与计数；`candidates` 是扫描 SQL 读出的行数，是 §11.9「SQL 侧窗口下界」那个 mutant 唯一能被看见的地方（TS 侧的再判定会挡掉多读的行，写出的行数不变）。作为 job 时，投递线关着只在第一次记一行 info。`pageSize` 只供测试演示跨页（`[own-3b-32]`）；另有一条保护：一整页的最后一行与上一页相同即停。
- 投递 job 的 worker 在 `resolveTaskNotificationDeliveryJob()` 那一刻构造一次（开关与通道表那时读），每次运行把本 tick 的时钟交给它（`[own-3b-33]`）；job 体是 `runUntilIdle({ budgetMs: TASK_DELIVERY_TICK_BUDGET_MS, stopping, stopSignal })`。
- 导出的常量：`TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS`（1 000）、`TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS`（30 000）、`TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS`（50，修订 6）、`TASK_SCHEDULER_STOP_GRACE_MS`（8 000）、`TASK_NOTIFICATION_BACKLOG_KINDS`（§4.1）。

### 3.3 worker 与通道

```ts
// src/services/task-notification-delivery-worker.ts
export type TaskDeliveryChannelResult =        // 定义在 src/tasks/task-delivery-protocol.ts，这里再导出
  | { ok: true }
  | { ok: false; retryable: boolean; error: string; skip?: boolean; outcomeUnknown?: boolean }
export interface TaskDeliveryPrepareTarget { deliveryId: string; orgId: string; recipientUserId: string }
export type TaskDeliveryPrepared =
  | { ok: true; send(message: { title: string; content: string }): Promise<TaskDeliveryChannelResult> }
  | { ok: false; result: TaskDeliveryChannelResult }
export interface TaskDeliveryChannel { readonly name: string; prepare(target: TaskDeliveryPrepareTarget): Promise<TaskDeliveryPrepared> }
export class TaskNotificationDeliveryWorker {
  constructor(options: { channels: TaskDeliveryChannel[]; query?: Q; batchSize?: number; leaseMs?: number
    maxAttempts?: number; sendLeaseMs?: number; workerId?: string; now?: () => Date; logger?: Logger; metrics?: DeliveryCounter
    env?: NodeJS.ProcessEnv                    // 构造时读一次 TASKS_ENABLED 与 worker flag（[own-3b-26]），缺省 process.env
    timers?: { set(cb: () => void, ms: number): unknown; clear(handle: unknown): void } })   // 每行预算的定时器源，缺省全局定时器（unref）
  readonly enabled: boolean                    // 两个开关在构造时是否都为 'true'；为 false 时两个方法不发任何语句、返回零
  readonly workerId: string; readonly batchSize: number
  // 一次 claim + 逐行处理 + 未处理行退还；stopSignal 一旦 abort，或在飞的行超过每行预算，其余未开始的行立即退还（§6.6、§7.2）
  runBatch(ctx?: { stopping?: () => boolean; stopSignal?: AbortSignal; deadline?: number }): Promise<{ claimed: number; sent: number; retrying: number; failed: number; skipped: number
    outcomeUnknown: number; lostLease: number; released: number; swept: { outcomeUnknown: number; exhausted: number } }>
  // 连续 runBatch，直到某批 claim 数 < batchSize、到达 budgetMs、或 stopping()；stopSignal 交给每一批
  runUntilIdle(ctx: { budgetMs: number; stopping?: () => boolean; stopSignal?: AbortSignal }): Promise<{ batches: number; totals: Record<string, number> }>
}
export const TASK_DELIVERY_WORKER_ERROR_CODES  // worker 自身步骤的固定码（[own-3b-29]）
export const TASK_DELIVERY_SKIP_CODES          // 发送时的 skip 码（§4.6、§7.4）
export function createTaskDeliveryChannelsFromEnv(env?: NodeJS.ProcessEnv): TaskDeliveryChannel[]   // 只看钉钉通道的 flag（§8.1）

// src/services/task-notification-dingtalk.ts
export class DingTalkTaskDeliveryChannel implements TaskDeliveryChannel {   // name = TASK_NOTIFICATION_CHANNEL_DINGTALK
  constructor(options?: { query?: Q; fetchAccessToken?: …; sendWorkNotification?: … })   // 后两项只供测试注入替身
}
export function classifyTaskDingTalkSendError(error: unknown, values: readonly string[]): TaskDeliveryChannelResult   // §8.4
export function redactTaskDingTalkErrorText(raw: string, values: readonly string[]): string                          // §8.5
export function normalizeTaskDingTalkBaseUrl(value: unknown): string                                                 // §8.2 第 3 步
export const TASK_DINGTALK_CHANNEL_CODES, TASK_DINGTALK_DEFAULT_BASE_URL, TASK_DINGTALK_ERROR_RAW_MAX_LENGTH
```

构造函数断言 `leaseMs > TASK_DELIVERY_ROW_RESERVE_MS`（§7.2），不满足直接抛错；`sendLeaseMs` 缺省取任务线常量（§7.2、§8.2），不读 env（这个选项只供测试）。

修订 5 按实现补记：`prepare` 的入参带投递 id（outbox 行 id），通道可以用于自己的日志，不得用于别的；「哪个 worker 发的」不经通道传递。错误文本：栅栏之前通道只返回固定码，栅栏之后为「固定码: 脱敏文本」（§8.5，`[own-3b-34]`）；worker 把通道给的文本截到 1000 字符写进 `last_error`，自己的步骤只写固定码（`[own-3b-29]`），从不写异常文本。通道的辅助项导出只为让单测直接钉住；它们引用钉钉客户端的错误类，所以放在服务层而不是 `src/tasks/`。

`prepare` 与 `send` 分开是本件与考勤 worker（`AttendanceNotificationDeliveryWorker.ts:433-478` 把身份、配置、token、发送全放在一个 `send` 里）的结构差异之一（另两处是栅栏续租与批末退还，§7.1）：效果栅栏（§7.2）必须落在「最后一次无副作用准备」与「唯一一次网络调用」之间。e-learning 线已经是这个形状（`elearning-notification-dingtalk.ts:237-335` 的 `prepare` 返回 `send` 闭包）。本件的逐行顺序是 物化（在职、各族 skip 规则、文案）→ prepare（身份、配置、token）→ 再物化一次 → 栅栏 → send（`[own-3b-37]`，修订 4）：会被跳过的行（含空汇总）在第一次物化就结束，不调通道、不取 token；第二次物化让最后一次状态判断与栅栏之间只隔一次数据库往返，prepare 里可能耗时的 token 获取不落在这段窗口里（§7.4）。

### 3.4 纯函数（`src/tasks/`，本件新增或追加）

| 模块 | 追加 / 新增 | 内容 |
|---|---|---|
| `task-reminders.ts`（追加） | `buildTaskReminderScanCondition({ nowParam, windowMsParam, afterAtParam, afterIdParam })`（带键集游标，§6.2）、`TASK_REMINDER_SCAN_BATCH = 500`、`TASK_DAILY_DIGEST_TIME_OF_DAY = '09:00'`、`computeDailyDigestSendAt(localDate, timeZone)`、`isDailyDigestDue(now, timeZone)`、`TASK_REMINDER_FLOOR_EVENT_TYPES = ['created','remind_changed']` | 扫描 SQL 片段、汇总到点判定（§6.2、§6.3） |
| `task-notifications.ts`（追加） | `TASK_NOTIFICATION_CHANNEL_DINGTALK = 'dingtalk_work_notification'`、`TASK_NOTIFICATION_SOURCE_TYPES`、`planTaskEventDeliveries(...)`、`planTaskReminderDeliveries(...)`、`planTaskDailyDigestDelivery(...)`、`planTaskListEventDeliveries(...)`：把网格结果展开成待插入的行（`source_type/source_id/source_key/recipient/role/channel/payload`） | 行形状只有一处定义（§5.2） |
| `task-notification-text.ts`（新） | `sanitizeTaskTextForMarkdown(text)`、`renderTaskDeliveryTag(deliveryId)`（`编号 <outbox 行 id 的前 8 位十六进制>`）、`renderTaskEventMessage(...)`、`renderTaskReminderMessage(...)`、`renderTaskDailyDigestMessage(...)`、`renderTaskListEventMessage(...)`（四个 render 都收 `deliveryId`，正文末行恒为该标签）、`TASK_DIGEST_MAX_ITEMS = 20` | 文案、转义、逐行唯一的正文（§8.3、§10.4） |
| `task-delivery-protocol.ts`（新） | `computeTaskDeliveryBackoffMs(attempt)`（阶梯 1m/5m/15m/1h/6h，同 `AttendanceNotificationDeliveryWorker.ts:228-234`）、`classifyTaskDeliveryOutcome({ result, attemptCount, maxAttempts, fenced })` → `'sent' \| 'retrying' \| 'failed' \| 'skipped' \| 'outcome_unknown'`、`TASK_DELIVERY_DEFAULTS`（batch 50 / 批租约 60s / maxAttempts 5 / 钉钉单次请求超时 10s / prepare 预算 12s / 物化余量 3s / 栅栏余量 5s / 每行预算 15s（= prepare 预算 + 物化余量，修订 6）/ 每行预留 30s/ 每 tick 投递预算 40s，§7.2）、`TASK_DELIVERY_PRIORITY_SOURCE_TYPES = ['task_reminder','task_daily']`、`orderClaimedDeliveries(rows)`、`TASK_EVENT_NOTIFICATION_MAX_AGE_MS`（24h）与 `isTaskEventNotificationStale(createdAt, now)`、`isAllowedTaskDingTalkBaseUrl(url)`、`clampDeliveryBatchSize`、`clampDeliveryLeaseMs` | worker 的判定不在服务里散写（门 20） |
| `task-access.ts`（改，任务 B 模块，需 owner 确认） | 私有生成器改成带参数：`taskOrgClauseWith(liveness)`，`taskOrgLiveClause()` 调它并传 `tasks.deleted_at IS NULL`（输出逐字节不变）；新导出 `buildTaskByIdAnyStateCondition({ taskIdParam, orgParam })`（不带存活条件，只供 worker 物化 `deleted` 族） | §7.4；约束见 §10 第 1 条 |
| `task-list-access.ts`（追加，PR-3a S5 新建的模块） | `buildTaskListsOfTaskCondition({ taskIdParam, orgParam })`：经 S5 的私有清单 org 生成器发射 org 子句，条件为「清单含该任务」 | producer 的清单成员扇出（§5.3） |

这些函数不 import `db/`、`pg`、`crypto`，不新增 `Intl.DateTimeFormat` 调用点（D12）：时区换算只经 `viewerToday`（`task-dates.ts:239`）与任务 D 已经引入的 `computeDateReminderOccurrence`。门 20 的 harness（`tests/unit/task-pure-no-io.test.ts`）会自动发现并用占位参数调用每个导出；新函数收到 `'x'` 时抛 `TypeError` 或返回否定结果即可（`isAllowedTaskDingTalkBaseUrl('x')` 为 `false`），不得碰 I/O。钉钉错误类的判别（`isDingTalkOutcomeUnknown`、`DingTalkRequestError`、`DingTalkBusinessError`）留在通道服务里，纯函数只接收通道给出的 `TaskDeliveryChannelResult`。

---

## 4. 服务分层

### 4.1 文件

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数 | §3.4 的四个新增 / 追加模块 | 规则、SQL 片段、文案 |
| 纯函数（改，N1 已裁） | `src/tasks/task-membership.ts` | N1：`applyRemoveAssignee` 在 `open→done` 时追加 `completed`，`applyAddAssignee` 在 `done→open` 时追加 `reopened`（§5.5） |
| 纯函数（改，需 owner 确认） | `src/tasks/task-access.ts` | `taskOrgClauseWith` + `buildTaskByIdAnyStateCondition`（§3.4、§7.4） |
| 纯函数（追加） | `src/tasks/task-list-access.ts`（PR-3a S5） | `buildTaskListsOfTaskCondition`（§5.3） |
| flag | `src/services/task-notification-flags.ts`（新） | 三个读函数 + `isTaskNotificationPipelineEnabled()` + `resolveTaskDeliveryChannelNames()` + `resolveTaskSchedulerIntervalMs()` |
| producer | `src/services/task-notification-producer.ts`（新） | §5；含 `resolveTaskDeliveryChannelsForOrg` 与 INSERT 文本（唯一一处） |
| 调度 | `src/services/task-scheduler.ts`（新） | §6；专用 leader 连接与其 `error` 监听；启动 / 停止在 `index.ts` 的 `startOnce()` / `stopOnce()`（§6.6） |
| worker | `src/services/task-notification-delivery-worker.ts`（新） | §7；含各族的 send 前物化（经单点构造器读任务 / 清单，经 PR-3a 的设置读取函数读设置，判 skip，调文案纯函数） |
| 通道 | `src/services/task-notification-dingtalk.ts`（新） | §8 |
| 既有服务（改） | `src/services/task-records.ts`（`writeEvents` 返回写入的事件；`completeTask` / `reopenTask` 挂 producer）、`src/services/task-structure.ts`（`writeMembershipEvents` 返回事件；`addAssignee` / `removeAssignee` / `switchCompletionMode` / `addComment` / `deleteTaskById` 挂 producer）、`src/services/task-list-records.ts`（PR-3a S5；归档 handler 挂 producer） | §5.3 |
| 指标 | `src/metrics/metrics.ts` | `tasks_scheduler_leader{state}` gauge、`tasks_notification_deliveries_total{outcome}` counter、`tasks_notification_backlog{kind}` gauge（`pending` 行数、最老一行已等待的秒数、`outcome_unknown` 行数；口径见下），照 `:479-489` 与 `:609-610` 的登记形；登记时每个标签值置零 |
| manifest | `scripts/ops/global-history-flag-manifest.mjs` | 三条新条目（§9.2）；`TASKS_ENABLED` 条目的 `purpose` 追加一句（S5） |

积压 gauge 的口径（`ASSUMPTION(task-m4): [own-3b-31]`，修订 5 按实现写明）：`pending` 计 `pending` 与 `retrying` 两种等待发送的行；`oldest_due_wait_seconds` 是已到期的等待行里最早的 `next_attempt_at` 到现在的秒数（尚未到期的退避行不算等待；没有已到期的行时为 0）；`outcome_unknown` 计该终态的行。三项各是一条以 `status` 开头的索引可答的子查询，每个 leader tick 在投递循环之后刷新一次，停机中不刷新；读失败只记 warn。

### 4.2 事务与锁

- **producer**：不开新事务、不取新锁，跑在调用方已经持有的事务里（大多数 handler 持 org 结构锁；`addComment` 持任务行 `FOR KEY SHARE`，`task-structure.ts:610-636`）。它的读（集成是否存在，以及负责人 / 关注人 / 清单成员）都是普通 SELECT。
- **调度 leader 锁**：每个 tick 先经 `connectLeaderClient()` 取一个**专用**客户端（生产为 `db/pg.ts` 的 `pool.connect()`；`pool` 为 `null` 时调度器根本不构造，§6.6），立即挂 `error` 监听（§6.1），然后在它上面开一条独立事务：`SET LOCAL lock_timeout = '<TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS>ms'`、`SET LOCAL idle_in_transaction_session_timeout = '<TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS>ms'`（修订 4，`[own-3b-35]`，§6.1），然后经 `acquireTasksSchedulerLeaderLock(query)`（`db/task-advisory-locks.ts:28-30`，取锁字面量仍只在那三个 helper 里，门 7 不变）取 `tasks-scheduler:leader`。这条事务里**没有数据语句**：两个扫描用连接池的其他连接发自动提交语句，只在每页之前、以及页内每再读一组至多 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS` 个 org 之前（修订 6），经 `ctx.leaderHeartbeat()` 在 leader 连接上发一句 `SELECT 1`（心跳，§6.1）；扫描结束后提交这条事务（锁随之释放），再归还客户端。锁 §6.4 对 leader 事务的限制由此成立：该事务里只有这一把锁。
- **提醒 / 汇总 producer 的写**：按页（每页至多 500 个任务）一条多值 `INSERT … ON CONFLICT DO NOTHING` 自动提交语句，不与 leader 事务同连接。
- **worker**：清扫、claim、栅栏（兼续租）、退还、终态各是一条自动提交的 UPDATE（`FOR UPDATE SKIP LOCKED` 在 claim 的 CTE 里，同 `AttendanceNotificationDeliveryWorker.ts:822-836`）；send 前物化的读是普通 SELECT。worker 从不取咨询锁，也不在 leader 事务期间运行（§6.4）。
- **不新增咨询锁键**：门 7 的多重集仍是三把 helper 各一次。

### 4.3 各触点的「读什么、调什么、写什么」

| 触点（既有 handler） | 事件来源 | producer 读 | 纯函数 | 写 |
|---|---|---|---|---|
| `completeTask`（`task-records.ts:637`；本节行号按 PR-3a `d940fa8745`） | `writeEvents` 返回的 `completed` / `completed_by_any`（`self_completed` 被网格拒绝） | 该 org 是否有活跃钉钉集成；关注人 id；清单成员 id（`buildTaskListsOfTaskCondition` ⋈ `task_list_members`，含已归档清单，§5.3）；负责人取写后的 `next.rows` | `resolveNotificationRecipients` → `planTaskEventDeliveries` | outbox 行 |
| `reopenTask`（`:661`） | `reopened`（`self_reopened` 被拒） | 同上 | 同上 | 同上 |
| `switchCompletionMode`（`task-structure.ts:406`） | `completed_by_any` | 同上 | 同上 | 同上 |
| `addAssignee` / `removeAssignee`（`:313`、`:347`） | N1 落地后的 `reopened` / `completed`；`assignee_added/removed` 本身不通知 | 同上，负责人取写后集合 | 同上 | 同上 |
| `addComment`（`:640`） | `commented` | 同上 | 同上 | 同上 |
| `deleteTaskById`（`:791`） | `deleted`（事件 id 提前生成后传入） | 同上（软删不删成员行） | 同上 | 同上 |
| 清单归档（`task-list-records.ts:331` `setTaskListArchived`；`writeListEvent`，`:198`，返回事件 id） | `task_list_events.archived` | 该 org 是否有活跃钉钉集成；清单行的 `created_by`（handler 锁后已读） | `resolveListArchiveNotificationRecipients` → `planTaskListEventDeliveries` | 第四族行 |
| `patchTask`、设父、关注人增删、退出、清单其余写 | 不在 D13 触发闭集 | — | — | 不挂 producer |

`writeEvents`（`task-records.ts:626`）与 `writeMembershipEvents`（`task-structure.ts:130`）改为返回 `WrittenTaskEvent[]`（id 在插入前生成，本来就是 `newTaskEventId()`），调用方把返回值交给 producer。`deleteTaskById` 与 `addComment` 的内联 INSERT 同样先生成 id 再插入。这是签名扩展，既有调用点不用改语义。

### 4.4 `version` 与 `updated_at`

本件不碰 `tasks.version` / `updated_at`；outbox 行的 `updated_at` 由 worker 的每次状态写更新。

### 4.5 事件

- 不新增 `task_events` / `task_list_events` 闭集词（N1 用的 `completed` / `reopened` 已在闭集）。
- N1 追加的事件 `actor_id` 是操作者，`payload` 为 `{}`（无 `targetUserId`），`occurred_at` 与同批 `assignee_removed` / `assignee_added` 相同。
- producer 不写事件行；它只读事件 id。

### 4.6 在职校验（`RULED(2026-10-07)`：[R17]，D13(f)）

发送前复核一次：worker 对每条 claim 到的行调 PR-3a S6 的 `findActiveOrgMembers(orgId, [recipientUserId])`（`task-org-members.ts`，判据与登录解析会话 org 相同）；不在结果里 ⇒ `skipped`，`last_error = 'recipient_inactive_in_org'`。producer 侧**不**校验（裁决包只要求发送时复核；请求路径少一次查询）。这一复核依赖 PR-3a S6 已提交，所以 S4 排在 S2 之后，而 S2 的入口条件已要求 PR-3a 的 head 含 S5–S9（§14）。R17 已裁（发送时复核，不在职即 skipped），helper 在 PR-3a head `d940fa8745` 的 `task-org-members.ts:21`，修订 1 为「R17 不采纳」准备的自带查询不再需要。

---

## 5. producer

### 5.1 flag 关着时：**什么都不写**（`ASSUMPTION(task-m4): [own-3b-01]`）

裁决包给了三个 flag，没有说 outbox 行在 flag 关着时是否照写。两种读法：

- (a) 总是写行，worker 关着就堆在 `pending`；
- (b) 投递线没有全开就一行也不写。

本件取 (b)，理由三条，每一条都能从裁决包已有的取值推出来：

1. R06 v2 给单任务提醒定了扫描窗：早于窗口的提醒不发，首次打开开关时也一样。事件族在 (a) 下没有对应的规则：worker 首次打开时会把关闭期间积累的「已完成」通知全部发出。(b) 让四个族一致：投递线关着的期间发生的事件**不会**在之后被补发。
2. `RULED(2026-10-07): [R13]`：M4 不做硬删（保留期另行裁定）。(a) 下每次完成 / 评论都会写最多 `1 + 50 + 50 + 100×10` 行（`ASSUMPTION(task-m4): [D14]` 的上界），没有消费者也没有清理，表只增不减。
3. 锁 §10 与 PR-3a §9.2 的部署耦合：flag 全 OFF 时，PR-3b 对请求路径的改动只剩一次内存里的 env 判断，M2/M3 行为逐字节不变；这是 Draft PR 叠栈、默认 OFF 姿态下最安全的形状。

(b) 只管**关闭期间新发生**的事件。**已经写下**的行不受开关影响：关掉 D 或 W 时，`pending` 行与钉钉故障留下的 `retrying` 行都原样留在表里，重新打开后照常可被 claim。所以对已写下的行，「关」是暂停而不是丢弃；它们发不发由发送时的新鲜度规则决定（`ASSUMPTION(task-m4): [own-3b-14]`，§7.4）：提醒族过了 W 记 `reminder_window_elapsed`，汇总族过了当天窗口记 `digest_window_elapsed`，事件族与清单族的行龄超过 `TASK_EVENT_NOTIFICATION_MAX_AGE_MS`（24 小时）记 `skipped/event_stale`。worker 停机、钉钉故障、调度停机之后恢复，也走同一套规则。owner 若要别的窗口值或完全暂存，见 §13-Q3。

判定用一个谓词：`isTaskNotificationPipelineEnabled(env) = 三个 flag 都严格等于 'true'`（`TASKS_ENABLED` 不在里面：producer 只会被已挂载的路由调到，路由挂载已经证明了它）。`resolveTaskDeliveryChannelNames(env)` 在谓词为真时返回 `[TASK_NOTIFICATION_CHANNEL_DINGTALK]`，否则 `[]`；producer 对每个收件人 × 每个通道名写一行。M4 只有一个通道，所以「全开」与「有通道」是同一件事；以后加通道时改这一个函数。

**按 org 的通道前提**（`ASSUMPTION(task-m4): [own-3b-13]`）：三个开关是进程级的，一旦打开，所有 org 的写路由都会调 producer。没有钉钉集成的 org 写出来的行注定发不出去，却会一直留在账本里（R13：M4 不做硬删）并占用投递预算。所以 producer 与两个扫描在写行前多一次判断：该 org 在 `directory_integrations` 里有 `provider='dingtalk' AND status='active'` 的行，才为钉钉通道写行；没有就一行不写。这一判断与发送时的身份 join 用同一个 org 口径（`i.org_id = 行的 org_id`，§8.2）。现状提示：`createDirectoryIntegration`（`directory/directory-sync.ts:2415-2432`）把新建的钉钉集成一律写在 `'default'` org 下；锁 §4.3 不允许回退到 `'default'`，所以 org 不是 `'default'` 的任务在这种部署里不会产生任何通知行。这是有意的失败即关闭，PR body 写明，是否另有映射方式见 §13-Q13。

### 5.2 行形状（四族）

| 族 | `source_type` | `source_id` | `source_key`（任务 D 的构造器） | `recipient_role` | `payload`（只有 id 与枚举，**没有标题、正文、URL**） |
|---|---|---|---|---|---|
| 事件 | `task_event` | taskId | `buildTaskEventSourceKey`（`task-reminders.ts:232-243`） | 网格给的四值之一 | `{ kind: 'task_event', event, taskId, eventId, actorId }` |
| 提醒 | `task_reminder` | taskId | `buildTaskReminderSourceKey`（`:219-229`，含 `remind_at` ISO） | `assignee`，零负责人 `creator`（`reminderRecipientRole`） | `{ kind: 'task_reminder', taskId, remindAt }` |
| 每日汇总 | `task_daily` | recipientUserId | `buildTaskDailyDigestSourceKey`（`:233-238`，`date` 是收件人当地日期） | `assignee`（`RULED(2026-10-07)`：[R05] [D13]，汇总按本人 assigned 臂派生，没有零负责人分支） | `{ kind: 'task_daily', date, timeZone }` |
| 清单事件 | `task_list_event` | listId | `buildTaskListEventSourceKey`（`:257-268`） | `list_member` | `{ kind: 'task_list_event', event: 'archived', listId, eventId, actorId }` |

`status = 'pending'`，`next_attempt_at = now()`（DB 默认），`attempt_count = 0`，`channel = 'dingtalk_work_notification'`。`org_id` 来自 handler 的 org（事件、清单）或行自己的 org（提醒、汇总）。

标题、正文在**发送时**由 worker 重读任务 / 清单行再经文案纯函数生成（§7.4）：outbox 行不存用户文本，任务软删或改名后账本里也没有残留正文；这也是为什么 payload 只有 id。

### 5.3 幂等与同事务

- 一条多值 `INSERT … ON CONFLICT (org_id, source_key) DO NOTHING RETURNING id`（同 `UnscheduledReminderService.ts:236-237`）。对同一事件、同一收件人、同一通道重复调用，表里始终只有一行，第二次的 `RETURNING` 为空；handler 事务回滚时行随之消失（M4-a 的「事务回滚不留行」格）。
- 事件族的键含 `eventId`，所以同一任务的两次完成（完成→重启→完成）是两个 outbox 行；它们到了钉钉那边能否都被看到，还取决于正文不相同（§8.3 的逐行标签）。提醒族的键含 `remind_at`，改期自然产生新键，旧行在发送时按 `isReminderSkippedByTaskState`（`task-reminders.ts:179-186`）判 skipped。
- 收件人集合：`resolveNotificationRecipients`（`task-notifications.ts:87`）负责排除 actor 与按优先级去重；producer 只负责把三张表的 id 喂进去。负责人、关注人与清单成员在 producer 里于调用方的同一连接上、写入之后读出（一条 `UNION ALL` 语句），所以就是写后集合（S2 实现说明：调用方不再另传负责人，见验证 MD S2）。清单成员 = 任务所在**全部**清单（含已归档）的全部成员；清单的 org 子句由 PR-3a S5 的私有生成器经新构造器 `buildTaskListsOfTaskCondition` 发射（`task_lists.org_id` 仍只有一处文本，D8），不在服务里另写。该语句的清单一支：

```sql
SELECT 'list_member' AS member_kind, tlm.user_id
  FROM task_lists
  JOIN task_list_members tlm ON tlm.list_id = task_lists.id
 WHERE <buildTaskListsOfTaskCondition({ taskIdParam, orgParam }).sql>
       -- 展开为：清单 org 子句 AND EXISTS (该清单的 task_list_items 含本任务)
```

  修订 2 更正：PR-3a S7 给 `task_list_items` 加了 `org_id` 列与两条组合外键（`(list_id, org_id)` 指向 `task_lists (id, org_id)`、`(task_id, org_id)` 指向 `tasks (id, org_id)`，`ASSUMPTION(task-m4): [own-37]`，迁移 `:111-123`），所以清单项的清单与任务在库层就是同一个 org；`loadActorListMemberships`（`task-records.ts:442`）另在两行上比较 org。producer 这里再带清单 org 子句：清单扇出只取任务所在 org 的清单的成员，与清单项行写了什么无关（§11.3 有格与负控）。
- 上界：`1 + 50 + 50 + 100 × 10`（`ASSUMPTION(task-m4): [D14]` 与 A5），每行一次 INSERT 的多值元组，写入量可控；投递侧怎样消化这种突发见 §6.4。

### 5.4 提醒族与汇总族的 producer

在调度 tick 里（§6.2、§6.3），同样只在投递线全开时写行，并且每个 tick 开头取一次「有活跃钉钉集成的 org 集合」，只为集合内 org 的任务与设置行写（`[own-3b-13]`）；写法与事件族同一条 INSERT 文本（`planTask*Deliveries` 给出行，INSERT 只有一处）。

### 5.5 N1（`RULED(2026-10-07)`：[N1]，改任务 C 模块）

`applyRemoveAssignee`（`task-membership.ts:97-119`）在 `all` 模式把状态从 `open` 提升为 `done` 时，事件数组追加 `{ type: 'completed', userId: actorId, occurredAt: now }`；`applyAddAssignee`（`:69-88`）在 `all` 模式把 `done` 改回 `open` 时追加 `{ type: 'reopened', userId: actorId }`。`TaskAssigneeEventType` 加这两个词。handler 不改：`writeMembershipEvents` 照写数组，`writeTaskDoneState` 本来就在状态变化时被调用（`task-structure.ts:311`、`:335`）。任务 C 在 `:90-96` 的 NOTE 里记录了这个空白，本件按裁决包 N1 的推荐值填上。

N1 已裁（2026-10-07），S3 必做。修订 2 补一条实现约束：只在状态真的翻转时追加（加人：`done → open`；删人：`open → done`），没有翻转（例如已完成的任务删掉一行、其余仍全部完成）就不追加任何事件。收件人按写后集合（§4.3），所以删人致完成时被删的人不在收件人里，加人致重启时新加的人作为负责人在收件人里（§13-Q22）。为什么放 PR-3b 而不是 PR-3a：消费方是本件的扇出；PR-3a 已经开工且明确不做；PR-3c 的 socket 用负责人集合前后并集（R16），不依赖这两个事件。

---

## 6. `TaskScheduler`

### 6.1 leader 锁：选择与失效模式

**选择**：锁 §6.4 已经把键（`tasks-scheduler:leader`）与取锁形式（`pg_advisory_xact_lock(hashtext($1))`，经 `acquireTasksSchedulerLeaderLock`）定死。这是一把**阻塞式、事务级**的锁，不是 try-lock，也不是 Redis 租约（考勤线用 `RedisLeaderLock`，`AttendanceScheduler.ts:216-231`；任务线不用）。所以 leader 不是一个粘住的角色，而是**每个 tick 的互斥**：

1. tick 开始：`connectLeaderClient()` 取一个专用客户端，**立刻**挂 `client.on('error', onLeaderClientError)`；开事务；`SET LOCAL lock_timeout = '1000ms'`（常量 `TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS`，不是 env）；调 helper 取锁。
2. 取到：本 tick 是 leader；在连接池的其他连接上依次跑两个扫描；提交事务（锁随之释放）；摘掉监听、归还客户端；然后跑投递循环（§6.4）。
3. 没取到（SQLSTATE `55P03` `lock_not_available`；`57014` 也按同样处理）：本 tick 是 follower；回滚；gauge 置 `follower`；两个扫描与投递都不跑；等下一个 tick 再试。

**为什么要专用客户端和 `error` 监听**：`ConnectionPool.transaction()`（`integration/db/connection-pool.ts:174-208`）不给借出的客户端挂任何 `error` 监听，而 pg-pool 3.10.1 在借出时会摘掉它自己的空闲监听（`pg-pool/index.js:308`）。leader 事务在两个扫描运行期间处于事务内空闲，这段时间里后端被终止（`idle_in_transaction_session_timeout`、运维 `pg_terminate_backend`、故障切换、网络断开）时，pg 客户端会发出没有监听者的 `error` 事件（`pg/lib/client.js` 的 `_handleErrorEvent`），在主进程里就是未捕获异常。所以调度器自己取客户端并全程挂监听：监听触发时置 `leaderLost`、gauge 置 `relinquished`、记 warn；tick 收尾时用 `release(err)` 销毁这个客户端，不把坏连接还回池子。两个扫描在两页之间检查 `leaderLost()`，为真就停（已写的行是幂等的，停下不丢）；投递循环不跑。

`lock_timeout` 对咨询锁的等待生效，这一点本件不当成常识，而是由 M4-d 的一格实证（§11.6）：连接 A 持锁时，B 经 helper 取锁必须在超时后以 `55P03` 失败，而不是一直挂着。

**为什么不换成 `pg_try_advisory_xact_lock`**：门 7 只登记三个 helper、三种字面量各恰一次；try 形式不在门 7 登记的三种字面量之内，也违反 §6.4「取锁写法唯一」的正文。用 `lock_timeout` 把阻塞锁变成有界等待，不碰 helper。

**leader 会话的服务端界限与心跳**（修订 4，`ASSUMPTION(task-m4): [own-3b-35]`）：leader 事务在两个扫描运行期间处于事务内空闲；若 leader 所在主机消失或与数据库之间发生网络分区而套接字没有关闭（半开），没有任何客户端动作能释放锁，只有服务端能结束该后端。所以 leader 事务在取锁之前 `SET LOCAL idle_in_transaction_session_timeout = TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS`（30 s；PG ≥ 9.6 的会话级参数，事务内生效，不需要 DDL，也不依赖服务端全局值——事务内的 `SET LOCAL` 优先）：这样的 leader 最迟在 30 s 后被服务端结束，锁随之释放。活着的 leader 不会被误伤：两个扫描在每页工作之前经 `ctx.leaderHeartbeat()` 在 leader 连接上发一句 `SELECT 1`（提醒扫描每页之前一次；汇总扫描在读设置之前与每条 INSERT 之前各一次），并且在一页之内（修订 6），按 org 的读以 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS`（50）个 org 为一组——提醒扫描每 org 一次前提读（每 tick 每 org 一次，缓存）、汇总扫描每 org 一次前提读与一次在职读——第一组由该页自己那次心跳覆盖，之后每组之前再心跳一次；每次都是**先心跳、再看 stopping / lost**，为真即停在这一组之前，不再发任何语句。所以一个活着的 leader 在事务内的空闲段至多是：提醒扫描一页的 SELECT、一组按 org 的前提读、本页的负责人读与它的 INSERT；汇总扫描的读设置加一组按 org 的两次读（每条 INSERT 之前另有一拍）——与 org 数、用户数无关；心跳失败与监听收到错误同样处理（`leaderLost`、gauge `relinquished`、本 tick 不提交、客户端销毁）。界限 30 s 高于这样一段的时长、远低于操作系统的 TCP keepalive；另一实例最迟在界限 + 一次锁等待 + 一个 interval 之后成为 leader。§11.6 有三格：用一个可冻结的 TCP 中继证明半开的 leader 在界限内失去后端、另一实例在下一个 tick 领导；一个超过界限的扫描靠心跳保持、不心跳则被结束；汇总扫描按 org 的阶段超过界限时靠组内心跳保持、每行都写出、另一实例在该阶段内是 follower（修订 6）。

**失效模式**（逐条写明，因为它们决定门 M4-d 的期望）：

| 情形 | 行为 | 后果 |
|---|---|---|
| leader 进程崩溃（操作系统关闭套接字） | 事务随连接消失，锁立即释放 | 下一个 tick 别的实例成为 leader；没有 TTL、没有续约、没有「僵尸 leader」 |
| leader 所在主机崩溃，或与数据库之间网络分区（没有 FIN / RST，套接字半开） | 服务端在 `idle_in_transaction_session_timeout`（30 s）到期时结束该后端，锁随之释放；上面的心跳让活着的 leader 不会碰到这个界限 | 其他实例最迟在界限 + 一次锁等待 + 一个 interval 之后成为 leader；在此之前所有实例的 tick 都是 `lock_busy`（界内的提醒与汇总不丢：它们仍在各自的窗口内） |
| leader 的 tick 超过 interval | 定时器再次触发时 `running` 为真 ⇒ 跳过（同 `AttendanceScheduler.ts:164-167` 的一次运行守卫） | 单实例内不重入 |
| 两个实例同时 tick | 一方拿到，另一方在 `lock_timeout` 内等待后 `55P03` | 两个扫描在同一时刻只有一方在跑；等待期间 `pg_locks` 有 `granted=false` 行、`wait_event='advisory'`（锁 §6.4 的判别式） |
| leader 事务的后端在扫描期间被终止（空闲超时、`pg_terminate_backend`、切换、断网），进程仍活着 | 监听收到错误（或心跳失败）：`leaderLost` 置真，gauge `relinquished`，扫描在下一页之前停下；客户端以 `release(err)` 销毁；本 tick 不跑投递 | 进程不退出。锁已随后端消失，另一实例可能在下一个 tick 开始扫描；扫描以 `(org_id, source_key)` 唯一键幂等，重叠只多做工，不多发。服务端全局的 `idle_in_transaction_session_timeout` 不影响 leader 会话（事务内的 `SET LOCAL` 优先） |
| 投递循环与另一实例的下一个 tick 重叠 | 投递在锁提交之后跑，另一实例拿到锁后也会跑自己的投递 | 两个 worker 同时 claim 是被设计覆盖的情形：`SKIP LOCKED` + 栅栏 CAS 保证不重发（§7.5）；投递的并发安全不依赖 leader 锁 |
| 时钟偏差 | 见 §6.5 | — |
| 锁 helper 被改坏（M4-d 负控） | 两方都跑扫描 | 该格必须变红 |

### 6.2 单任务提醒 tick

**输入**：`now`（§6.5）、`TASK_REMINDER_SCAN_WINDOW_MS`（`task-reminders.ts:151`，2 小时）。

**SQL**（服务层，`WHERE` 文本来自 `buildTaskReminderScanCondition`；按页取，每页至多 `TASK_REMINDER_SCAN_BATCH = 500` 行）：

```sql
SELECT t.id, t.org_id, t.created_by, t.remind_at, f.floor
  FROM tasks t
  LEFT JOIN LATERAL (
    SELECT max(e.occurred_at) AS floor
      FROM task_events e
     WHERE e.task_id = t.id AND e.event_type IN ('created', 'remind_changed')
  ) f ON true
 WHERE t.remind_at IS NOT NULL
   AND t.remind_at <= $1::timestamptz
   AND t.remind_at >  $1::timestamptz - ($2::int * interval '1 millisecond')
   AND t.status = 'open' AND t.deleted_at IS NULL
   AND (t.remind_at, t.id) > ($4::timestamptz, $5::text)      -- 键集游标：上一页最后一行
 ORDER BY t.remind_at ASC, t.id ASC
 LIMIT $3
```

**一个 tick 把窗口排空**（`ASSUMPTION(task-m4): [own-3b-15]`）：第一页的游标是 `('-infinity', '')`；每页处理完，把游标推进到这一页最后一行的 `(remind_at, id)`，再取下一页；某页返回的行数少于页大小即停，或 `stopping()` / `leaderLost()` 为真即停。修订前的写法（固定 `LIMIT` 且没有游标）每个 tick 都拿回同一批最早的 500 行：已入队的只会撞唯一键，floor 不满足的每次都被重新读出又丢掉，排在第 500 行之后的到点提醒永远轮不到；全天提醒的缺省时刻都落在 18:00（`task-reminders.ts:116-136`），扫描又是跨 org 的，所以这不是极端情形（评审者在一次性库上复现过：600 个同一时刻到点的任务只入队 500 个）。修订 1 在一次性库（已删除）上用 650 个同一时刻的任务、其中按 id 排在最前的 50 个 floor 不满足，实测键集写法一个 tick 两页入队全部 600 个。

**判定仍在 TS**：对每行调 `isTaskReminderDue(remindAt, now, floor)`（`task-reminders.ts:160-162`，它原样调用 `isDateReminderDue`，`automation-date-reminder.ts:312-324`）。floor 不进 SQL：进了 SQL，TS 里 floor 项的变异就再也看不见（§11.9）；键集游标已经让 floor 不满足的行只是被跳过，不再占住名额。`floor` 为 NULL（没有 `created` / `remind_changed` 事件，只可能是测试直发 SQL 造的行）⇒ **不发**，记 debug（fail-closed：没有 floor 就无法证明提醒是在时刻之前写下的）。窗口的上下界在 SQL 里也有一份，那是取候选用的；它和 TS 的窗口项各由一个格钉住（§11.9 的变异对照表）。

**每 tick 的代价**：窗口 W 内全部开放、未删、有 `remind_at` 的任务每个 tick 都被读一遍，已入队的在 INSERT 上撞唯一键后什么也不写。代价与「W 内到点的开放任务数」成正比（每 500 个一页，外加每页一次负责人查询与一条 INSERT）；P1 规模下可接受，量上去之后的优化（例如按已入队的 `(任务, remind_at)` 排除）另议——它会改变「tick 之后才加进来的负责人能否收到这次提醒」的语义，所以本件不做。

窗与 floor 的含义（`RULED(2026-10-07)`：[R06]）：

- `remind_at ≤ now`：到点；`remind_at > now − W`：不补发早于两小时的提醒（首次打开开关、或调度停机超过 W，都不会倒出旧提醒）；`remind_at ≥ floor`：写入时已经过去的时刻不发（与 `shouldEnqueueReminder`，`:152-154` 同一件事的扫描侧）。
- `W ≥ 2 × interval`（修订 4，`ASSUMPTION(task-m4): [own-3b-39]`）：interval 的上限是 W/2（`TASK_SCHEDULER_INTERVAL_MAX_MS` = 3 600 000），所以一次失败的 tick（`leader_unavailable`、锁忙）之后，下一次 tick 的窗口仍覆盖上一次成功 tick 之后超过两倍定时器迟到量的每个时刻（修订 6 的措辞：紧跟在一次 tick 之后、不超过两倍迟到量的那一小段只由失败的那一次 tick 覆盖，是与迟到量同阶的区间，本件接受）；env 旋钮由 `resolveTaskSchedulerIntervalMs` 夹到 `[5 000, W/2]`（manifest 同步），构造函数对收到的 `intervalMs` **校验**（整数且在该区间内，否则抛 `TypeError`）而不夹取。

**收件人**：每页一次批量 `SELECT task_id, user_id, completed_at FROM task_assignees WHERE task_id = ANY($1)`，再对每个到点任务调 `resolveReminderRecipients`（`task-notifications.ts:107-115`：未完成的负责人；零负责人行时创建人）与 `reminderRecipientRole`。关注人不收提醒。在 tick 之后才加进来的负责人，在同一个 `remind_at` 仍处于 W 内的后续 tick 里会得到自己的一行（键里有收件人）。

**写**：`planTaskReminderDeliveries` 展开成行，每页一条多值 INSERT（§5.3），只为 `[own-3b-13]` 集合内 org 的任务写。本页到点行的各 org（去重、按页内顺序）先问一次前提（每 tick 每 org 一次，缓存），每 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS` 个 org 一组，第一组之后每组之前心跳并看 stopping / lost（§6.1，修订 6）；为真即不写本页并停下。两拍之间的语句至多是一页的 SELECT、一组前提读、本页的负责人读与它的 INSERT。

**到点时的状态复核**在 worker（§7.4），不在这里：tick 与发送之间任务可能已完成、软删或改期。

### 6.3 每日汇总 tick

**收件人**：`SELECT user_id, org_id, time_zone FROM task_user_settings WHERE daily_reminder_enabled = true AND time_zone IS NOT NULL`（CHECK 保证开了就有时区；`IS NOT NULL` 只是显式）。每 tick 全表；P1 规模小。到点的收件人按 org 分组后，每个 org 一次 `findActiveOrgMembers(db, orgId, userIds)`：发送时的在职判据（`RULED(2026-10-07)`：[R17]）在扫描时也应用一次（修订 4，`ASSUMPTION(task-m4): [own-3b-38]`），已离开 org 的设置行不写行（否则每天一行永久的 `skipped`），设置行本身不动；结果计数 `inactiveMember`。按 org 的这两次读以 `TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS` 个 org 为一组，第一组由读设置之前那次心跳覆盖，之后每组之前心跳并看 stopping / lost（§6.1，修订 6）；为真即停，已算出的计划不写（INSERT 幂等，下一个 tick 从头再来）。

**到点判定**（`RULED(2026-10-07)`：[R07]；`ASSUMPTION(task-m4)`：[own-3b-02]）：

- `localDate = viewerToday(now, tz)`（`task-dates.ts:239`）；
- `sendAt = computeDailyDigestSendAt(localDate, tz)` = `computeDateReminderOccurrence(localDate, { timeOfDay: '09:00', offsetDays: 0, direction: 'before', timezone: tz }, { floating: true })`，与任务 D 的全天提醒同一条换算路径，不新增 Intl 调用点；
- `isDailyDigestDue(now, tz)` = `isDateReminderDue(sendAt, now, W, 0)`：`sendAt ≤ now < sendAt + W`。floor 传 0（epoch），因为汇总没有「写入时刻」这个概念；窗口是唯一的下界。

于是 09:00 固定（R07），迟到上限是 W（本件自选，`[own-3b-02]`）：调度在 08:00–12:00 停机的那天，该用户没有汇总，也**不会**在 15:00 补一份「早报」。要不要允许当天任何时刻补发，见 §13-Q4。

**写**：对每个到点用户（只限 `[own-3b-13]` 集合内的 org），一行 `task_daily:<localDate>:recipient:<uid>:channel:<ch>`，`status='pending'`，payload `{ kind:'task_daily', date, timeZone }`；计划按每 `TASK_REMINDER_SCAN_BATCH` 个一条 INSERT 写入，每条之前心跳并看 `stopping()` / `leaderLost()`（时区解析不了的设置行计入 `invalidZone` 并跳过，不拖垮整次扫描）。冲突即当天已处理（不论那一行最终是 `sent` 还是 `skipped/empty_digest`），这正是 R07 v2 要的「当天有标记」。

**内容在发送时算**（`ASSUMPTION(task-m4): [own-3b-03]`）：worker 用 `buildTaskDailyDigestCondition`（`task-reminders.ts:319-330`；`$1` 用户、`$2` org、`$3` 用户时区；由 assigned 臂派生）取行，空则 `skipped` + `last_error='empty_digest'`，非空才渲染发送。这样汇总总是发送那一刻的真实待办（09:00–09:01 之间完成的任务不会出现在 09:01 发出的汇总里），而 tick 侧不必为每个用户先查存在再算内容。代价：`empty_digest` 这个终态由 worker 而不是 tick 写下，两者之间的行短暂处于 `pending`；R07 v2 关心的是「当天恰好一行」，这一点不变。裁决包写的是 tick 侧记 skipped，本件的偏差列在 §13-Q5。

**TS/SQL 双形对拍**：`isInDailyDigest`（`:299-311`）与 `buildTaskDailyDigestCondition` 的 `now()`（`:337-338`）是两份文本；§11.5 给对拍格。

### 6.4 tick 的顺序与预算

一个 leader tick：① 提醒扫描 → ② 汇总扫描（① ② 在 leader 事务持锁期间跑）→ 提交、释放锁、归还专用客户端 → ③ 投递循环（`resolveTaskNotificationDeliveryJob()` 只在 worker flag 为 `'true'` 时注册，同 `AttendanceScheduler.ts:399-412` 的形）。三个 job 各自 try/catch，一个失败不影响其余（`AttendanceScheduler.ts:188-199`）。① ② 在投递线未全开时（§5.1）直接返回，只记一次 info。

**投递为什么放在锁外**（`ASSUMPTION(task-m4): [own-3b-07]`，修订 1 改写）：投递的并发安全来自 `SKIP LOCKED` 与栅栏 CAS（§7.5），不来自 leader 锁；放在持锁事务里只会把 leader 连接的事务内空闲时间拉长到整段发送，扩大 §6.1 所说的后端终止暴露面。投递仍然只由赢得本 tick 的实例启动（每个 tick 至多一个实例开始投递），但两个实例的投递循环可以在时间上重叠，这是被覆盖的情形。

**投递循环**：③ 调 `worker.runUntilIdle({ budgetMs: TASK_DELIVERY_TICK_BUDGET_MS, stopping })`：连续 `runBatch()`，直到某一批 claim 到的行数少于批大小（队列里到期的行已取完）、累计用时到达预算（40 秒，小于 60 秒的 interval，给下一个 tick 留出空档）、或 `stopping()`。每批内部的逐行处理与退还见 §7.2。

**优先级**（`ASSUMPTION(task-m4): [own-3b-16]`）：claim 先取有时间窗的两族（`task_reminder`、`task_daily`），再按 `next_attempt_at, created_at, id` 取其余（§7.2）。理由：这两族过了窗口就在发送时被跳过（§7.4），而事件族有 24 小时的新鲜度；一次大的事件扇出不应把当天的提醒与汇总挤出窗口。事件族会因此等待，但有窗口的两族总量有界（每个 `(任务, remind_at, 收件人)` 一行、每人每天一行），不会让事件族无限期饿死。

**容量**（写进 PR body）：投递吞吐不再是固定的「每 tick 一批 50 行」，而是「每 tick 至多 40 秒的逐行发送」：设每行平均耗时为 ℓ（主要是钉钉发送一次的往返），每分钟约可发 `40s / ℓ` 行（ℓ = 300ms 时约 130 行 / 分钟、约 8000 行 / 小时）。D14 的单事件上界 1101 行在这个速率下约需 8–9 分钟；有窗口的两族优先，不受它挤压。没有按 org 的公平调度：一个 org 的大扇出会让别的 org 的事件通知排队（不影响提醒与汇总）；P1 接受，写进 PR body。钉钉侧的应用级限流是确定拒绝，走退避（§8.5）。

### 6.5 `now`、时区、时钟偏差

- 每个 tick 开头一次 `SELECT now()`，得到 `dbNow`；tick 内所有纯函数与 worker 用 `createDbAnchoredClock(dbNow)`：`() => new Date(dbNow + (performance.now() − anchor))`。多实例的应用时钟偏差因此不进入判定；只有 DB 一个时钟。
- 提醒族只有瞬时（`remind_at`、`now`、`floor`），不涉及时区。
- 汇总族的时区**只**来自 `task_user_settings.time_zone`（R07），不看请求头，不看任务自己的 `time_zone`；每个 (用户, org) 一份。
- 文案里的截止时间按任务四列原样显示（`due_date`、`due_time`、`time_zone` 名），不换算到收件人时区（锁 §4.4「全天 floating 不换算」的口径延伸到定时任务：不在 P1 引入第二套换算）。
- DST：`sendAt` 逐日重算；某日当地 09:00 不存在或出现两次时取 `computeDateReminderOccurrence` 给出的那个瞬时，W 让前后一小时的漂移无害。
- 测试：`readNow` 与 `now` 都可注入；步进时钟；没有 sleep。真库里 `now()` 只出现在事件默认值与汇总内容 SQL 里，对应格用相对播种加翻转点等待（PR-3a §10.5 的方法）。

### 6.6 启动、停止、多实例

- `startTaskScheduler()`：`TASKS_ENABLED === 'true' && TASKS_SCHEDULER_ENABLED === 'true'` 且 `db/pg.ts` 的 `pool` 不为 `null`（该导出的类型是 `PgPool | null`）才构造并 `start()`；开关不全时返回 `null` 并 info「disabled」，`pool` 为 `null` 时返回 `null` 并 warn（开关开着却没有连接池，是部署错误，不静默）。在 `index.ts` `startOnce()` 里紧接考勤调度的那一段（`:4151-4172` 之后）另起一段；`stopOnce()` 在 `:3733-3738` 之后加 `await stopTaskScheduler()`。只构造 `MetaSheetServer` 而不 `start()` 的测试（门 13 那一类）不会碰到它。
- `start()`：`setInterval(interval).unref()`；首个 tick 不立即跑（等一个 interval）。
- `stop()`：清定时器，置 `stopping`，**abort 停机信号**（一个 `AbortSignal`，随 job 上下文交给投递循环，修订 4），等在飞 tick 完成，上限 `TASK_SCHEDULER_STOP_GRACE_MS = 8000`（`ASSUMPTION(task-m4): [own-3b-08]`）。这个值必须小于 `stopOnce()` 的关停屏障：`waitForShutdownBarrier`（`index.ts:3500-3524`）写死 10 秒，超时即抛 `SHUTDOWN_TIMEOUT`，其后的 `pool.end()`（`:3838`）不会执行。`stopping` 置真之后：扫描在下一页之前停；worker 不再 claim、**也不再对新的行过栅栏**；**本批尚未开始的行在信号到达那一刻立即按 §7.2 退还（不消耗次数），不等在飞的那一行返回**；在飞的那一行（至多一行）：尚未过栅栏的，在 `prepare` 之前、再物化之前、栅栏之前三处检查点里最近的一处退还（修订 6：停机落在第一次物化期间的行不调通道，落在 `prepare` 期间的行不再读状态）；已经过了栅栏、正在发送的，照常等它的终态写。若该次发送在 8 秒内没有返回，`stop()` 先返回，进程随后退出，这一行停在 `sending`，下一次任一实例的清扫把它写成 `outcome_unknown`（§7.1 已接受的去向，不重发）。同理，若 `stop()` 到达上限时在飞的那一行还在 `prepare` / 物化之中（尚未过栅栏），进程退出前来不及把它退还：它保留这次 claim 已消耗的一次次数，批租约过期后被重新 claim。**每次停机至多影响在飞的那一行**，次数消耗有界；§11.6 有格（真调度器、阻塞的 prepare、短宽限：`stop()` 仍 pending 时其余行已退还，修订 6 起在返回之前观察）。
- 多实例：每个实例各自 tick；每个 tick 谁拿到锁谁跑扫描并随后启动投递；follower 每 tick 等最多 1s。gauge `tasks_scheduler_leader{state}` 反映**上一个 tick** 的结果（`leader` / `follower` / `relinquished`）。

---

## 7. delivery worker

### 7.1 状态机（`ASSUMPTION(task-m4): [own-3b-04]`）

```
pending / retrying ──claim（批租约，status 不变，attempt_count +1）──▶ pending / retrying + 活租约
        │                  │                                              │
        │ 批内没轮到：       │ 租约过期，未过栅栏                              │ 栅栏 UPDATE（CAS，同时把租约续成
        │ 退还（次数 −1）    ▼                                              ▼  恰好覆盖一次发送）
        │            可被重新 claim（该次 attempt 已消耗）                  sending ──终态 CAS──▶ sent | retrying | failed | skipped | outcome_unknown
        ▼                                                                   │
  pending / retrying（无租约，立即可 claim）                                  │ 续租后的租约过期仍是 sending
                                                                            ▼
                                                                     outcome_unknown（清扫，永不重发）
```

与考勤 worker 的差别有两处：考勤在 claim 时就把行写成 `sending`（`AttendanceNotificationDeliveryWorker.ts:838-840`），过期的 `sending` 会被重新 claim 并**重发**（`:829-832`）；本件的 `sending` 只在网络调用前那一刻写入，过期的 `sending` 是终态 `outcome_unknown`。另外，考勤把一整批行放在同一个租约下逐行处理；本件的栅栏把单行的租约续成 `sendLease`，批内没轮到的行在批结束时退还，不消耗次数（§7.2）。所以：

**保证（精确表述）**：对每一条 outbox 行，外部发送在同一次 claim 内至多发起一次；发送一旦发起，只有当通道给出**确定的拒绝**（通道把结果标成可重试或不可重试的明确拒绝，且不是 outcomeUnknown，§8.4）时才会在下一次 claim 再次发起；进程崩溃、超时、5xx、响应畸形、发送抛出无法归类的错误、发送超过续租后的租约，都终止于 `outcome_unknown`，不再发送。因此**不会重复发送**（at-most-once 效果），代价是 `outcome_unknown` 行需要人工核对（§7.6）。这与 e-learning 线的栅栏原则（`elearning-notification-dispatch.ts:28-33`、`:94-100`）和考勤 worker 里记录的 owner 口径（`:79-85`：对不确定结果重发是重复通知风险）一致；考勤自己的过期重发路径是早于该口径的遗留，本件不复制。

**`sent` 的含义**：钉钉 `asyncsend_v2` 受理并返回 `task_id`，不等于员工已经看到（§8.3 列出已知的静默未达路径）。账本不回查钉钉的发送结果接口。

### 7.2 claim / 租约 / 栅栏 / 终态

**常量**（`ASSUMPTION(task-m4): [own-3b-08]`，`TASK_DELIVERY_DEFAULTS`）：批租约 `leaseMs = 60s`；钉钉单次请求超时 `TASK_DINGTALK_REQUEST_TIMEOUT_MS = 10s`（经 `options.timeoutMs` 传给发送与 token 获取，§8.2）；prepare 预算 `TASK_DELIVERY_PREPARE_BUDGET_MS = 12s`（修订 6；通道自己把 token 获取与它竞速，§8.2 第 4 步）；物化余量 `TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS = 3s`（修订 6）；栅栏余量 5s；`sendLease = 10s + 5s = 15s`；每行预留 `TASK_DELIVERY_ROW_RESERVE_MS = 每行预算 + sendLease = 30s`。构造函数断言 `leaseMs > TASK_DELIVERY_ROW_RESERVE_MS`。这几个值都是任务线常量，与 env `DINGTALK_REQUEST_TIMEOUT_MS`（`transport.ts:97-100`，无上界）无关。

**每行预算**（修订 4，`ASSUMPTION(task-m4): [own-3b-36]`）：`TASK_DELIVERY_ROW_BUDGET_MS = prepare 预算 + 物化余量 = 15s`（修订 6），是一行在栅栏之前（payload 检查、物化、prepare、再物化）最多可用的时间，也就是预留里不属于发送租约的那一部分；它严格大于 prepare 预算，所以用满预算而成功的 `prepare` 仍在每行预算之内，两次物化有 3 s 余量。两道界的先后：token 等待由 prepare 预算先截（通道内竞速，`dingtalk_token_unavailable`，有界重试）；每行预算是外层的界，只在物化慢、或通道没有守住自己的预算时触发。超过预算的行**不过栅栏**，以 `retrying / row_budget_exceeded` 结束（这次 claim 的次数已消耗，有界重试）；worker 用一个定时器量在飞的行（生产为 unref 的 `setTimeout`，测试可注入），一行一旦超过预算，本批其余未开始的行**立即**退还，不等这一行返回。于是每行预留的算术对每一行都成立：到达栅栏的行在栅栏前最多用了 15 s，栅栏后最多 15 s；一行卡住（数据库停顿、事件循环停顿）最多让它自己多用一次次数，排在它后面的行不会在它身后失去租约（§7.5）。

**清扫（每批开头）**：

```sql
-- 发送已发起、续租后的租约过期：终态，永不重发
UPDATE task_notification_deliveries
   SET status = 'outcome_unknown', last_error = 'lease_expired_after_send_started',
       claim_expires_at = NULL, updated_at = $1
 WHERE status = 'sending' AND claim_expires_at <= $1;
-- 次数用尽（崩溃在栅栏前反复重 claim 的毒行）
UPDATE task_notification_deliveries
   SET status = 'failed', last_error = 'attempts_exhausted',
       redelivery_safe = (channel = $3),                  -- $3 = 钉钉通道名；这类行从未有过不确定的发送
       claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $1
 WHERE status IN ('pending','retrying') AND attempt_count >= $2
   AND (claim_expires_at IS NULL OR claim_expires_at <= $1);
```

处于 `pending` / `retrying` 的行要么从未发起过发送，要么过去的每次发送都得到了确定的拒绝（不确定的结果直接进 `outcome_unknown`），所以次数用尽的 `failed` 与其他 `failed` 一样是确定的未送达，`redelivery_safe` 同样置真。

**claim**（一条语句）：

```sql
WITH claim AS (
  SELECT id FROM task_notification_deliveries
   WHERE status IN ('pending','retrying')
     AND next_attempt_at <= $1
     AND attempt_count < $2
     AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
     AND channel = ANY($5)                       -- 只 claim 已注册通道的行
   ORDER BY (source_type = ANY($7::text[])) DESC, -- $7 = TASK_DELIVERY_PRIORITY_SOURCE_TYPES（§6.4）
            next_attempt_at ASC, created_at ASC, id ASC
   LIMIT $3 FOR UPDATE SKIP LOCKED
)
UPDATE task_notification_deliveries d
   SET claim_worker_id = $4, claimed_at = $1,
       claim_expires_at = $1 + ($6::int * interval '1 millisecond'),
       attempt_count = attempt_count + 1, updated_at = $1
  FROM claim WHERE d.id = claim.id
RETURNING d.id::text, d.org_id, d.source_type, d.source_id, d.source_key,
          d.recipient_user_id, d.recipient_role, d.channel, d.attempt_count, d.payload,
          d.next_attempt_at, d.created_at, d.claim_expires_at
```

`UPDATE … RETURNING` 不保证行序，所以 worker 拿到结果后用纯函数 `orderClaimedDeliveries` 按与上面 `ORDER BY` 相同的键重新排序再逐行处理。

**索引的实际用法**（修订 1 更正）：`idx_tskn_claim (status, next_attempt_at)` 不能按上面的排序键直接输出行。修订 1 在一次性库（已删除）上对「20 万行 `sent` + 200 行到期」做 `EXPLAIN ANALYZE`：规划器经以 `status` 开头的索引只读出 200 行到期行，再在内存里排序（quicksort 42kB）→ `LockRows` → `Limit 50`；清扫二同样走 `status` 索引。所以 claim 的代价与**到期积压**成正比，而不是与账本总行数成正比；积压很大时（评审者在 10 万行到期的库上看到外排序）每次 claim 都要排一遍积压。PR-3b 不做 DDL；若要消除这种排序，需要在 PR-3a 仍未应用的迁移里加部分索引 `(next_attempt_at, created_at) WHERE status IN ('pending','retrying')`，作为给 PR-3a 的可选建议记在 §13-Q17，P1 规模下不是前提。

`attempt_count` 在 claim 时加一（同考勤 `:840`）：崩溃在栅栏前的行每次重 claim 都消耗一次，`maxAttempts` 之后被清扫成 `failed`，不会无限循环。没有发送却消耗次数的情形有两种：栅栏前崩溃（重 claim），以及一行超过每行预算（`row_budget_exceeded`，有界重试）；批内没轮到的行走下面的退还，不消耗。

**逐行处理与批的时间界**：按序处理每一行之前先看两件事：`stopping()` 为真（或停机信号已 abort），或这一批的 `claim_expires_at − now < TASK_DELIVERY_ROW_RESERVE_MS`（或调用方给的 `deadline` 已到）——任一成立就不再开始新行，把本批剩下的行全部退还。开始一行后的顺序：payload 形状检查 → send 前物化（§7.4）→ `channel.prepare()`（§8.2）→ 再物化一次 → 栅栏 → send（`[own-3b-37]`）。栅栏之前的任一环节判 skip / retryable / failed 时直接写终态（CAS 见下），不过栅栏；物化之后、prepare 之后、再物化之后各看一次每行预算，超过即 `row_budget_exceeded`，三处各守一条规则（修订 6）：第一次物化之后超预算的行**不调通道**；`prepare` 之后超预算的行**丢弃已备好的闭包、不再读状态**；再物化之后超预算的行**不过栅栏**。`prepare` 之前、再物化之前、紧挨栅栏之前各看一次 `stopping()`（修订 6）：为真则这一行不过栅栏，并入退还（§6.6）。一行在飞期间，停机信号到达或这一行超过每行预算时，其余未开始的行**立即**退还（一条退还语句），不等这一行返回。

**退还**（批结束时对没轮到的行，一条语句）：

```sql
UPDATE task_notification_deliveries d
   SET claim_worker_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
       attempt_count = d.attempt_count - 1, updated_at = $1
  FROM unnest($2::uuid[], $3::int[]) AS r(id, n)
 WHERE d.id = r.id AND d.claim_worker_id = $4 AND d.attempt_count = r.n
   AND d.status IN ('pending','retrying')
```

退还的行立即可被下一批 claim；`attempt_count` 回到 claim 之前的值（CHECK `attempt_count >= 0` 不受影响，因为 `n ≥ 1`）。CAS 不匹配（别的 worker 在租约过期后已经重新 claim）就什么也不做。

**栅栏**（进入 `sending` 的唯一途径，同时续租）：

```sql
UPDATE task_notification_deliveries
   SET status = 'sending', last_attempt_at = $1, updated_at = $1,
       claim_expires_at = $1 + ($5::int * interval '1 millisecond')   -- $5 = sendLease：只覆盖这一次发送
 WHERE id = $2::uuid AND claim_worker_id = $3 AND attempt_count = $4
   AND status IN ('pending','retrying')
   AND claim_expires_at > $1                                          -- 本次 claim 的租约仍然有效
RETURNING id
```

0 行 ⇒ 租约已丢（别的 worker 已重新 claim，或本批已超出租约）：**不发送**，记 `lost-lease`，行留给清扫 / 重新 claim。1 行 ⇒ 这一行的租约此刻起恰为 `sendLease`，与它在批里排第几无关；send 层不自动重试（`client.ts:1104-1107` 的 `'send'` 层），超时由任务线常量限定，所以栅栏之后恰好一次 HTTP 请求，时长有界。

**终态 CAS**（`sent` / `retrying` / `failed` / `skipped` / `outcome_unknown` 五条 UPDATE 同形，照考勤 `:977-1085`，会把 `claim_worker_id` 清空）：`WHERE id AND status = 'sending' AND claim_worker_id = $w AND attempt_count = $n`；0 行 ⇒ `lost-lease`（清扫已经把它写成 `outcome_unknown`；不覆盖）。栅栏前的终态（skip、prepare 失败）用 `status IN ('pending','retrying')` 版本的同一 CAS。

**redelivery_safe**：`failed` 且通道是钉钉 ⇒ `true`（同考勤 `:1031`：能到 `failed` 的都是确定的未送达），次数用尽的清扫同样置真；`outcome_unknown` 保持 `false`。

### 7.3 尝试计数、退避、毒行、顺序

- `maxAttempts` 默认 5；退避阶梯 `computeTaskDeliveryBackoffMs`：1 分钟 / 5 / 15 / 60 / 360 分钟（`AttendanceNotificationDeliveryWorker.ts:228-234` 同值）。`retrying` 行的 `next_attempt_at = now + backoff(attempt_count)`。
- 可重试失败在第 `maxAttempts` 次仍失败 ⇒ `failed`（不是 skipped）。
- 毒行三类：payload 解析失败 / `kind` 未知 ⇒ `failed`（`payload_invalid` / `unknown_kind`，不重试）；物化抛出异常 ⇒ 按可重试失败计（有界）；崩溃在栅栏前反复 ⇒ 清扫 `attempts_exhausted`。
- 顺序：批内按 claim 的排序键（有窗口的两族在前，然后 `next_attempt_at, created_at, id`）；**不保证**同一收件人的通知按事件顺序到达（一条重试中的旧通知可能晚于新通知）。P1 接受，写进 PR body。
- 批大小默认 50（`[1, 200]`）；每 tick 连续多批，直到队列取空或 40 秒预算用完（§6.4）。每批实际处理的行数受 `TASK_DELIVERY_ROW_RESERVE_MS` 限制，没轮到的行退还。

### 7.4 send 前物化：各族的 skip 规则（`RULED(2026-10-07)`：[R06] [R07] [R05] [D13]；`ASSUMPTION(task-m4)`：[own-3b-05] [own-3b-14]）

物化运行两次（修订 4，`ASSUMPTION(task-m4): [own-3b-37]`）：第一次在 `prepare()` 之前——会被跳过的行（在职、新鲜度、各族 skip 规则，含空汇总）在这里就结束，不调通道、不取 token；第二次在 `prepare()` 之后、栅栏之前——最后一次状态判断与栅栏之间只隔一次数据库往返，不会被 token 获取拉长，发送用第二次的文案。两次都按下面的规则判定。所有族先过三道共同检查：payload 形状 ⇒ `payload_invalid`（在 prepare 之前）；在职复核（§4.6）⇒ `recipient_inactive_in_org`；事件族与清单族另加新鲜度：`isTaskEventNotificationStale(row.created_at, now)`（行龄超过 `TASK_EVENT_NOTIFICATION_MAX_AGE_MS` = 24 小时）⇒ `skipped/event_stale`，零发送。然后按族：

| 族 | 读 | skip 条件（`last_error` 固定码） | 文案输入 |
|---|---|---|---|
| `task_event` | 非 `deleted` 事件：任务行经 `buildTaskByIdCondition({ taskIdParam, orgParam })`（`task-access.ts:310-315`，含存活条件）；`deleted` 事件：经 `buildTaskByIdAnyStateCondition`（§3.4）；负责人、关注人、收件人的清单身份（`loadActorListMemberships`，`task-records.ts:421`） | 非 `deleted` 事件：行不存在（不存在或已软删）`task_missing`；`deleted` 事件：行不存在 `task_missing`；`can(resolveTaskRoles(row, recipient, memberships), 'view')` 为假 `recipient_lost_access` | 标题、事件类型 |
| `task_reminder` | 任务行经 `buildTaskByIdCondition`（含 `remind_at`、`status`；已软删的行取不到）、负责人行 | 行不存在（已软删或不存在）`reminder_stale`；`isReminderSkippedByTaskState(task, payload.remindAt)` 为真 `reminder_stale`（已完成 / `remind_at` 已变或清空）；`isTaskReminderDue(remindAt, now, floor)` 为假 `reminder_window_elapsed`（worker 停机超过 W 后不补发）；收件人已不在尚未完成的负责人之中（任务没有负责人时，收件人已不是创建人）`recipient_lost_access` | 标题、截止四列 |
| `task_daily` | 设置行经 PR-3a 的 `task-user-settings.ts` 读取函数（不另写查询）、`buildTaskDailyDigestCondition` 的行集（按 `due_at NULLS LAST, due_date, id`，取 `TASK_DIGEST_MAX_ITEMS + 1`） | 设置已关或时区已变 `digest_settings_changed`；`payload.date ≠ viewerToday(now, tz)` 或 `isDailyDigestDue` 为假 `digest_window_elapsed`；行集为空 `empty_digest` | 条目列表、总数 |
| `task_list_event` | 清单行经 PR-3a S5 的 `buildTaskListByIdCondition`（已归档清单也能取到，S2 入口时重核它的谓词） | 行不存在 `list_missing`；收件人不再是 `created_by` `recipient_lost_access` | 清单名 |

**org 子句只经单点构造器**（修订 1 更正）：修订前这些读在 worker 里自写 `WHERE id = $1 AND org_id = $2`。那样写出来的四处 org 子句不在 `taskOrgLiveClause`（`task-access.ts:188-194`）与 PR-3a 的清单 org 生成器之内，门 1 的单点 org mutant 打不到它们，租户隔离回归在这条路径上没有任何门能看见。现在任务行只经 `buildTaskByIdCondition`（`deleted` 事件族之外的一切）或 `buildTaskByIdAnyStateCondition`（只有 `deleted` 事件族），清单行只经 `buildTaskListByIdCondition`，汇总行集经 `buildTaskDailyDigestCondition`（它由 `buildTaskScopeCondition` 派生），设置行经 PR-3a 的服务函数。`buildTaskByIdAnyStateCondition` 的约束见 §10 第 1 条；它改的是任务 B 的模块，需 owner 确认（§13-Q14），在确认之前以推荐形交付并标 `ASSUMPTION(task-m4): [own-3b-17]`；owner 不同意时的退路是 `deleted` 事件族不通知（producer 不为 `deleted` 事件写行，记为对 D13 的偏离），而不是在 worker 里另写 org 子句。

### 7.5 并发、崩溃、停机

- **两个 worker 同时 claim**：`SKIP LOCKED` 加租约谓词，同一行不会被两方同时持有；栅栏与终态的 CAS 再挡一次（`claim_worker_id` + `attempt_count`）。租约谓词挡的是「同一行被两个 worker 轮流持有、次数被白白消耗」；即使它被删掉，栅栏 CAS 仍会让旧持有者在发送前失败，所以「不重发」的证明要同时针对这两道（§11.6）。
- **崩溃在栅栏前**：行仍 `pending/retrying`，批租约过期后被任何实例重新 claim；没有发送发生过，所以不丢也不重；这一次 claim 消耗了一次次数（毒行因此有界）。
- **批内没轮到**：批的剩余租约不够 `TASK_DELIVERY_ROW_RESERVE_MS`、到了截止时间或 `stopping()` 时，剩下的行在批结束时退还（次数回退），立即可被下一批 claim。所以发送慢（但每次都成功）只会降低吞吐，不会让任何行在没有发送的情况下耗尽次数。
- **一行超过每行预算**（prepare 或物化卡住，`[own-3b-36]`）：其余未开始的行在超预算那一刻退还（次数回退），不等它返回；它自己返回后不过栅栏，记 `retrying / row_budget_exceeded`（次数已消耗、有界）。所以一行卡住最多让它自己多用一次次数，排在它后面的行不会在它身后被别的 worker 当作租约过期的行清扫或重 claim（§11.6 有格）。
- **崩溃在栅栏后**：行是 `sending`，续租后的租约（`sendLease` = 15s）过期后清扫为 `outcome_unknown`；不重发。
- **发送慢于续租后的租约**（进程在栅栏之后停顿超过 15 秒；网络请求本身被 10 秒超时限住）：清扫先写 `outcome_unknown`；原 worker 随后的终态 CAS 失败 ⇒ `lost-lease`，日志 warn；账本保守。续租让这个窗口只取决于这一行自己的发送，与它在批里排第几无关。
- **停机**：§6.6。

### 7.6 `outcome_unknown` 与 `redelivery_safe` 的去向

本件只写这两个字段，不提供重投接口或作业（裁决包没有列；考勤的 `AttendanceNotificationRedelivery.ts` 是它自己线的东西）。人工核对经数据库查询 `status = 'outcome_unknown'`；要不要一条只读的账本接口，见 §13-Q7。

---

## 8. 钉钉通道

### 8.1 注册

`createTaskDeliveryChannelsFromEnv(env)`：`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED === 'true'` 才 `push(new DingTalkTaskDeliveryChannel())`，否则返回 `[]`（D4；`AttendanceNotificationDeliveryWorker.ts:370-401` 同形）。没有假通道 flag：测试用构造函数注入的 fake（§11.1），不占一个 `TASKS_*_ENABLED` 名字。通道名 `dingtalk_work_notification`，与 producer 写行时用的同一个常量。

**注册只看开关**（修订 5 按实现写明）：本通道的应用配置只存在于每个 org 的集成行上（`[own-3b-19]`，§8.2 第 2 步：配置只有这一个来源；§11.9 的「配置改从进程环境读取」是必须变红的 mutant），进程里没有本通道要检查的配置，所以注册只看开关，配置在每一行 `prepare` 时检查：集成行缺配置 ⇒ `retrying / dingtalk_config_unavailable`，受 `maxAttempts` 约束后成为 `failed`。

### 8.2 `prepare`：身份、配置、token（无副作用）

1. **身份解析**，org 限定的目录三表 join（同 `AttendanceNotificationDeliveryWorker.ts:484-501`，另取出这一行集成的 `config`；e-learning 的 `elearning-notification-dingtalk.ts:145-171` 另加了 `user_orgs` 合取，本件的在职复核在物化时由 worker 做，不重复）：

```sql
SELECT i.id::text AS integration_id, a.external_user_id, i.config AS integration_config
  FROM directory_account_links l
  JOIN directory_accounts a ON a.id = l.directory_account_id AND a.provider = 'dingtalk' AND a.is_active = true
  JOIN directory_integrations i ON i.id = a.integration_id AND i.provider = 'dingtalk' AND i.status = 'active' AND i.org_id = $2
 WHERE l.local_user_id = $1 AND l.link_status = 'linked'
 ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
 LIMIT 2
```

   结果分支（`ASSUMPTION(task-m4): [D4] [own-3b-18]`）：
   - 0 行时再查一次该 org 的钉钉集成行（一条 `SELECT`，任意状态）：
     - 该 org **一行钉钉集成都没有** ⇒ `skip`，`dingtalk_org_integration_missing`。producer 的 org 前提（§5.1）通常已让这类 org 不产生行；这一支处理「入队之后集成被删」的竞态。
     - 有集成行但**没有一行是 `active`** ⇒ `skip`，`dingtalk_org_integration_inactive`（与 D4 的推荐值一致：收件人此刻没有可用的钉钉绑定，记 skipped 与固定码）。考勤 H1 的做法是按可重试处理、集成恢复后自愈（`AttendanceNotificationDeliveryWorker.ts:503-532`）；本件不默认采用，列为 §13-Q15 的备选。
     - 有活跃集成 ⇒ `skip`，`dingtalk_recipient_not_bound`（D4：没有绑定的收件人记 skipped 与固定码）。
   - 2 行 ⇒ `failed`，`dingtalk_recipient_ambiguous`（目录数据异常）。
   - `external_user_id` 空 ⇒ `skip`，`dingtalk_recipient_not_bound`。

   org 限定保证同一本地用户在别的 org 的绑定不会被用到。集成行的 org 口径见 §5.1 的现状提示：新建的钉钉集成落在 `'default'` org 下，本通道不回退（锁 §4.3），测试夹具直接在任务所在 org 播种 `directory_integrations` 行（§11.1）。
2. **配置只取同一行集成**（`ASSUMPTION(task-m4): [own-3b-19]`）：从上面那一行的 `integration_config` 读 `appKey`、`appSecret`（解密）、`workNotificationAgentId ?? agentId`（解密并规范化）、`baseUrl`，形状与 e-learning 的 `readPinnedMessageConfig`（`elearning-notification-dingtalk.ts:117-138`）相同，本件复制一份（计划 §6「复制不共享」）。本通道的应用配置**只有这一个来源**。理由：钉钉的 userid 只在它所属的企业内有意义，所以发送所用的应用必须与身份来自同一行集成。缺任一项 ⇒ `retryable`，`dingtalk_config_unavailable`（与 e-learning 在 prepare 阶段的口径一致，`elearning-notification-dingtalk.ts:262-265`；受 `maxAttempts` 约束）。部署后果：只在 env 里配了工作通知应用、集成行没有存 `workNotificationAgentId` 的部署（`createDirectoryIntegration` 允许它为 `null`，`directory/directory-sync.ts:2438-2440`），任务通知会停在这一支，最终 `failed`；PR body 写明，是否接受见 §13-Q20。
3. **出站地址**：`isAllowedTaskDingTalkBaseUrl(config.baseUrl ?? 'https://oapi.dingtalk.com')` 为假 ⇒ `failed`（不可重试），`dingtalk_base_url_rejected`，且不发 token 请求（§8.5）。
4. **token**：`fetchDingTalkAppAccessToken(config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })`（read 层，传输层自带有界重试；`options` 见 `client.ts:91-96`）；通道自己把这个 promise 与 `AbortSignal.timeout(TASK_DELIVERY_PREPARE_BUDGET_MS)` 竞速（修订 4）——客户端对同一应用共享在飞的 token 请求，传进客户端的信号会支配（或被）别的调用方的请求，所以预算在通道内执行、不传信号；超出预算、失败或为空 ⇒ `retryable`，`dingtalk_token_unavailable`。
5. **取 token 之后再解析一次身份与配置**，与第 1、2 步的结果逐项比较（集成 id、userid、appKey、appSecret、agentId、baseUrl），不同 ⇒ `retryable`，`dingtalk_destination_changed`（e-learning 的 token 后复核，`elearning-notification-dingtalk.ts:280-291`）。这样 prepare 用掉的时间不会让发送用上一份过时的身份。
6. 返回 `send` 闭包：闭包内**只有**一次 `sendDingTalkWorkNotification(accessToken, { userIds: [dingTalkUserId], title, content }, config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS })`（`client.ts:1067-1128`）；返回体没有 `task_id` ⇒ `outcomeUnknown`，`dingtalk_send_response_invalid`（e-learning `:323-327` 同口径）。

### 8.3 payload 与文案

`sendDingTalkWorkNotification` 固定发 `msgtype: 'markdown'`（`client.ts:1094-1101`），正文是 `### ${title}\n\n${content}`。文案由 `task-notification-text.ts` 生成：

| 族 | 标题 | 正文 |
|---|---|---|
| 事件 | 「任务动态」 | `completed`/`completed_by_any`：任务「T」已完成；`reopened`：任务「T」已重启；`deleted`：任务「T」已被删除；`commented`：任务「T」有新评论 |
| 提醒 | 「任务提醒」 | 任务「T」的提醒时间已到；有截止则加一行 `截止：<due_date> [<due_time>]（<time_zone>）` |
| 汇总 | 「今日任务」 | 前 `TASK_DIGEST_MAX_ITEMS` 条 `- 「T」（<due_date> …）`，超出加 `另有 N 项` |
| 清单事件 | 「清单动态」 | 清单「L」已归档 |

四族正文的最后一行都是 `renderTaskDeliveryTag(deliveryId)`：`编号 <outbox 行 id 的前 8 位十六进制>`（`ASSUMPTION(task-m4): [own-3b-20]`）。理由：评审者引用钉钉工作通知文档指出，同一应用给同一员工一天只投递一条内容完全相同的通知，接口照样返回 `task_id`（这一条修订 1 没有自行核对原页，按评审者引用记录）。标题与句式是固定的，所以正文需要一处逐行不同的内容；这一行提供它：每个 outbox 行的正文都不同。它不是用户文本，也不是 URL。改用时间戳之类的其他区分方式见 §13-Q16。

**`sent` 的定义与已知的静默未达路径**（写进 PR body）：`sent` = `asyncsend_v2` 受理并返回 `task_id`（§7.1）。以下情形账本仍记 `sent` 而员工可能看不到：平台的同内容去重（上面的标签已针对它）、评审者引用的企业内部应用每员工每日条数上限（修订 1 未自行核对）、收件人不在应用的可见范围内。账本不回查发送结果接口。

**用户文本先转义**（`sanitizeTaskTextForMarkdown`，§10.4）：把 `[ ] ( ) < > ! # * _ ~ \`` 与换行替换成全角或空格。`RULED(2026-10-09)`：正文里的用户文本（标题、清单名、汇总条目、时区名）把 ASCII `:` 渲染为全角 `：`，在转义之前应用；正文的固定部分（标签、截止时间）不是用户文本、保持原样。M4 不带 deep link（考勤的 actionCard 需要 `PUBLIC_APP_URL` 与它自己的 flag；任务线没有这两样，§13-Q6）。不显示操作者姓名（少一次 `users` 读；P1 够用）。

### 8.4 结果分类

栅栏**之前**（prepare 的各支）按 §8.2 写明的码分类，没有发送发生过。栅栏**之后**，通道的 `classifyTaskDingTalkSendError` 按下面的规则分类（修订 6：只写规则）：

- `isDingTalkOutcomeUnknown(error)`（`transport.ts:226-231`：超时、网络错误、5xx、畸形 2xx）⇒ `outcomeUnknown`；
- `DingTalkRequestError`（此时只剩被传输层判为确定拒绝的状态码）⇒ 按状态码分可重试 / 不可重试（408、429 与 5xx 可重试，其余不可重试）；
- `DingTalkBusinessError` ⇒ 按 errcode 与文本分可重试 / 不可重试；
- **其余一律 `outcomeUnknown`**（栅栏之后抛出一个认不出的错误，并不能说明请求没有发出去）。

栅栏之后只有明确的拒绝才会让这一行在下一次 claim 再发（§7.1）。

### 8.5 限流、env 门、出站、日志

- 限流：钉钉的流控 errcode / 429 是确定拒绝，走退避；没有客户端限速器，吞吐见 §6.4 的容量陈述。
- 出站地址（`ASSUMPTION(task-m4): [own-3b-21]`）：本通道的请求经 `integrations/dingtalk/transport.ts` 直接发出，不经过仓库里的出站守卫；主机只来自产生身份的那一行集成的 `baseUrl`，缺省 `https://oapi.dingtalk.com`（`client.ts:172-175`）。本通道只接受协议为 `https:`、主机为 `oapi.dingtalk.com` 或以 `.dingtalk.com` 结尾的地址（纯函数 `isAllowedTaskDingTalkBaseUrl`），否则按 §8.2 第 3 步失败，且不发 token 请求。经代理或自建网关的部署需要放宽时见 §13-Q18。outbox 行与文案里没有任何 URL。`DINGTALK_ALLOWED_CORP_IDS`（`runtime-policy.ts`）照既有客户端行为，本件不另加检查。
- 日志：只记 delivery id、org id、状态、固定错误码；本通道的两次出站调用都带 `logUpstreamMessage: false`（客户端转发给传输层的可选项，修订 4），传输层对被拒的响应只记 HTTP 状态与一句固定说明，不记上游原文。`last_error` 的传输文本按下面的顺序处理（`ASSUMPTION(task-m4): [own-3b-34] [own-3b-40]`）：先截到 `TASK_DINGTALK_ERROR_RAW_MAX_LENGTH`（4096）字符再做任何事（对不可信文本只做有界的工作），截断落在某个待去值内部时连同该值的前段一起丢掉；按长度从长到短、以字面替换去掉闭包持有的每个值（token、appKey、appSecret、agent id、收件人的钉钉 id、标题、正文、正文的每一行、每段「」里的用户文本，两个字符以上）；再替换带密钥的查询参数、`key=value` / `key: value` / `"key":"value"` 密钥对与 `Bearer` 令牌、URL 与主机名（带可选 user-info 的 scheme、字母顶级标签的点分主机或 IPv4 字面、可选端口与路径）；控制与格式字符（C0、DEL、C1、行 / 段分隔符、零宽与双向控制符）换成空格；截到 240 个 UTF-16 码元，两次截断都不落在代理对中间（修订 6）；worker 再截 1000（不会生效）。
- **脱敏的已知限制**（修订 6，按规则陈述）：脱敏只按上面列出的值与模式处理。值表按字面匹配，所以值的变形副本——传输层只回显一行里的一个片段、JSON 转义形、大小写变化形——不在值表内；URL 规则只认点分字母顶级标签主机与 IPv4 字面，所以方括号 IPv6 字面、不带点的主机加端口、IDN 主机不在规则内；URL 规则在控制 / 格式字符替换之前运行，所以主机名内部夹着格式字符的 URL 不按整体识别；密钥对规则只认列出的键名与双引号，所以闭包不持有的其他密钥在表外键名或单引号形里时不在规则内。各项的理由各一行：出站主机钉在钉钉域名、闭包持有的值已按字面全部去掉，这些形式只可能来自上游消息字段本身；规则的扩展留待有具体输入形态时再做。
- `last_error` 的格式（`ASSUMPTION(task-m4): [own-3b-34]`，修订 5 按实现写明）：栅栏之前通道只返回固定码（§8.2 各支的码；token 请求失败时的文本整段丢掉，因为它可能带着请求地址里的密钥参数）；栅栏之后为「固定码: 脱敏后的传输文本」，固定码是 `dingtalk_send_outcome_unknown`、`dingtalk_request_<HTTP 状态码>`、`dingtalk_business_error_<errcode 或 unknown>`、`dingtalk_send_unclassified` 之一，脱敏后什么也不剩时只写固定码；返回体没有任务 id 时只有 `dingtalk_send_response_invalid`。

---

## 9. flag、manifest、守卫、部署耦合

### 9.1 三个 flag 与 `TASKS_ENABLED` 的组合

| flag | 读点 | 控制 | 与其他 flag 的关系 |
|---|---|---|---|
| `TASKS_SCHEDULER_ENABLED` | `task-notification-flags.ts#isTasksSchedulerEnabled`（启动时） | `TaskScheduler` 是否构造与启动 | 还要求 `TASKS_ENABLED === 'true'`（`[own-3b-06]`：主开关关着时不得有任何任务线的后台副作用） |
| `TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` | `#isTaskNotificationDeliveryWorkerEnabled`（启动时） | 投递 job 是否注册到调度器 | 没有调度器就不跑（attendance 形状） |
| `TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` | `#isTaskDingTalkWorkNotificationEnabled`（启动时） | 钉钉通道是否注册 | 没有 worker 就没人调它 |
| （派生）投递线全开 | `#isTaskNotificationPipelineEnabled`（调用时） | producer 是否写行、两个扫描是否产出 | 三者都为 `'true'` |

真值表（`TASKS_ENABLED='true'` 为前提；它为 `false` 时路由不挂载、调度不启动，四行全是「无」）：

| S | W | D | 调度循环 | 提醒/汇总产出 | 事件族产出 | claim | 通道 |
|---|---|---|---|---|---|---|---|
| off | * | * | 无 | 无 | 无 | 无 | 无 |
| on | off | * | 跑，两个扫描空转 | 无 | 无 | 无 | 无 |
| on | on | off | 跑 | 无 | 无 | 0（注册通道为空，claim 谓词 `channel = ANY([])`） | 无 |
| on | on | on | 跑 | 有（只限有活跃钉钉集成的 org，§5.1） | 有（同左） | 有 | 钉钉 |

`TASKS_SCHEDULER_INTERVAL_MS` 是数值旋钮，不是开关（D3）：默认 60000，夹在 `[5000, W/2]`（修订 4）；S1 起作为 `numeric` 条目登记 manifest（验证 MD S1.7 第 1 条）。没有 `TASKS_SCHEDULER_LEADER_LOCK_ENABLED`：leader 锁常开（D3）；源码与注释里都不得出现这个名字，否则发现式核对会要求登记。

### 9.2 manifest 条目（门 18 的 M4 子集）

`scripts/ops/global-history-flag-manifest.mjs` 加三条，形状照 `:674-686` 与 e-learning 条目（`:512-560`）：

| key | type / activation | dependsOn（只作文档） | rules | danger | source |
|---|---|---|---|---|---|
| `TASKS_SCHEDULER_ENABLED` | boolean / `'true'` | `['TASKS_ENABLED']` | 不设 | medium | `packages/core-backend/src/services/task-notification-flags.ts#isTasksSchedulerEnabled` |
| `TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED` | 同上 | `['TASKS_ENABLED','TASKS_SCHEDULER_ENABLED']` | 不设 | medium | `…#isTaskNotificationDeliveryWorkerEnabled` |
| `TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED` | 同上 | `['TASKS_ENABLED','TASKS_SCHEDULER_ENABLED','TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED']` | 不设 | high（外部消息出站） | `…#isTaskDingTalkWorkNotificationEnabled` |

**为什么不设 `rules`**（`ASSUMPTION(task-m4): [own-3b-22]`，修订 1 改）：`evaluateFlagRules`（`:779-819`）只对带 `rules` 的条目产生 violation，而这些 violation 在运维的 flag 状态工具里是两种模式下都成立的「停」条件（`scripts/ops/multitable-global-history-flag-status.mjs:10`、`:182-184`，有停止项即非零退出，`:323`）。三个开关的「只开子不开父」在运行时已经是惰性的（§9.1 真值表：没有调度器就没有 worker，没有 worker 就没人调通道），加 `rules` 不增加安全，只会从一个 Draft PR 给共享的运维工具新增停止条件；另外 `global-history-flag-manifest.test.mjs:510-519` 把全体 rule id 钉成一个固定集合，加规则就必须同片改那份测试。e-learning 的 `ELEARNING_NOTIFICATIONS_ENABLED`（`:514-522`）正是只写 `dependsOn`、不写 `rules` 的先例。所以本件三条只写 `dependsOn` 作文档，不动 manifest 测试。要不要把它们升级为 `requires` 规则，见 §13-Q19。

`purpose` 写明：默认 OFF、严格 `'true'`、三者都开才会有行与发送、只为有活跃钉钉集成的 org 写行、`TASKS_ENABLED` 与 M4 迁移是前提、M4 不做硬删与清理作业、outbox 行因此一直保留（`RULED(2026-10-07): [R13]`，保留期另行裁定）、发送配置只取身份所在的集成行。`TASKS_ENABLED` 条目的 `purpose` 追加一句「它也是任务调度器与投递 worker 的前提」——这个条目 PR-3a 的 S5、S8 还会改，所以这一句放在 S5 片（届时 PR-3a 已过 S8，§14）。

负控（门 18）：删掉任一条目 ⇒ `global-history-flag-manifest.test.mjs` 的完整性断言红（源码里有该 token 而 manifest 没有）；反过来源码里删掉一个读点 ⇒ phantom 断言红。rule id 集合断言（`:510-519`）不受影响，因为本件不加规则。

### 9.3 会话 feature payload 与前端

- `routes/auth.ts` 的 `buildFeaturePayload`（origin/main `:284-318`）**不加任何键**。origin/main 自 #6191（`2a0dc44718`）起有守卫 `tests/unit/approval-feature-payload-flag-ledger.test.ts`：该字面量的每个键都要在 `docs/development/approval-parity-execution-ledger-20260817.md` §7 的 `Payload key` 列登记。PR-3b 不动那个字面量，所以不需要台账行；PR-3b rebase 到含 #6191 的 main 之后该守卫仍绿。本件写作时的 PR-3a 工作树基于更早的 main，验证 MD 要记录 rebase 后重跑该测试的结果。
- `TASKS_ENABLED` 今天怎么到前端：**不经 payload**。它唯一的源码读点是 `routes/tasks.ts:44`（工厂返回 `null`，路由不挂载）；前端 `apps/web/src/tasks/tasksContext.ts:11-16` 把 `GET /api/tasks/context` 的 404 归为 `unavailable`，不断言开关值；导航入口只看 `tasks:read` 权限（`apps/web/src/App.vue:199-202`）。三个新 flag 完全不到前端：它们只控制后台循环，前端没有任何面需要知道。
- 因此 PR-3b 对 `featureFlags.ts`、`useAuth`、路由 meta 零改动。

### 9.4 部署耦合与 staging / prod 陈述

- PR-3b 无 DDL；它依赖 PR-3a 的迁移已应用于任何 `TASKS_ENABLED='true'` 的环境（PR-3a §9.2 的三态表照抄进 PR body）。
- 三个 flag 默认 OFF，容器 env 不设即关。staging window-runner 只认识 `TASKS_ENABLED`（`scripts/ops/attendance-staging-window-runner-remote.sh:1519` 的候选名单、`.github/workflows/attendance-staging-window-runner.yml:114` 的 `tasks_enabled` 输入），**没有**这三个 flag 的输入；本 PR 不改共享 workflow，所以合并后 staging 上仍然关着，且 runner 的 status 不会报告它们（它们不在候选名单里——若有人手工写进 host env file，runner 不会发现）。要在 staging 真投递一次（R01 ④、计划 M4 行），需要另一个 owner 授权的 runner 改动 + 钉钉凭据 + 目录绑定，见 §13-Q8。
- prod：只经 `docker-build.yml` 手动 dispatch 发布与部署；flag 由 host env 控制；本件不触达。
- 回退：代码回退即停（无 schema 变化）；已写入的 outbox 行保留；`outcome_unknown` 行的补偿是人工的、逐条的，需 owner 授权（同 PR-3a §9.2 三层回退的第三层）。

### 9.5 守卫清单

| 守卫 | 要求 | 本 PR 的做法 |
|---|---|---|
| `task-ci-coverage-enumeration.test.ts`（门 17 ④） | 磁盘 `task-*.db.test.ts` = exclude 字面量 = `tasks-realdb.yml` 清单；每文件含 `assert-rbac-optional-off` import | 四个新文件（§11.1）同片三处登记 |
| 门 17 ② | lane verbose 收集数 = 静态展开数 | 验证 MD 逐文件列 |
| `global-history-flag-manifest.test.mjs` | 源码 `TASKS_*_ENABLED` token 与 manifest 双向一致；全体 rule id 等于钉死的集合（`:510-519`） | 三条目，不带 `rules`（§9.2），测试文件不改；源码与注释只出现这三个名字 |
| `approval-feature-payload-flag-ledger.test.ts`（origin/main） | payload 键 ⊆ 台账 | 不改 payload |
| 门 7 | 任务域源码咨询锁字面量恰三处 | 不新增；`SET LOCAL lock_timeout` 不是取锁字面量 |
| 门 15 | 生产源码注释不点名其他线符号 | 注释只引条目 id；不写考勤 / e-learning 文件名 |
| 门 20 | `src/tasks` 无 I/O | 新纯函数不 import `db` / `pg` / `crypto`；harness 自动覆盖 |
| hourcycle 守卫 | `Intl.DateTimeFormat` 调用点 | 不新增（D12） |
| `tasks-auth-ci-wiring.test.mjs` | `routes/tasks.ts` 的 `TASKS_ENABLED` 字面量 | 不改；新 flag 模块用 `=== 'true'` 形，不复制那条字面量 |
| `metrics-integration.test.ts` | 指标注册 | 三个新指标照既有登记形（修订 5：仓库里没有这个测试文件，验证 MD S4.10；三个指标的登记与零样本由 worker 与调度器的单测钉住） |
| 共享 CI | 只改 `tasks-realdb.yml` | 只加四个文件；总时长逼近 25 分钟时调该 workflow 自己的 `timeout-minutes` |
| sha 钉住的文件 | `plugin-tests.yml`、`pnpm-lock.yaml` | 不碰；不加依赖（`nodemailer` 等不需要） |

### 9.6 哪些 lane 在 Draft PR 上跑

同 PR-3a §9.4：以 PR-3a 分支为基时 `tasks-realdb` 与 `recovery-schema-drift` 触发；`plugin-tests`（manifest 测试、门 20 harness、三集合枚举、payload 台账守卫）、`web-tests`、contracts、`migration-replay` 不触发，本地跑并记进验证 MD。

---

## 10. 安全与租户审视

1. **org 限定，每条查询，经单点构造器**：producer 的 org 来自 handler（`req.authenticatedTenantId` 已落行）；提醒扫描每行带自己的 `tasks.org_id`；汇总每行带 `task_user_settings.org_id`；worker 的读都绑 outbox 行的 `org_id`，任务行经 `buildTaskByIdCondition` / `buildTaskByIdAnyStateCondition`，清单行经 `buildTaskListByIdCondition`，清单成员扇出经 `buildTaskListsOfTaskCondition`（§5.3、§7.4），服务里不再手写 `tasks.org_id` / `task_lists.org_id` 子句；身份 join 带 `directory_integrations.org_id = $2`。没有默认 org，列上 `NOT NULL` 无默认值（D1）。`task-access.ts` 的改动须满足：门 1 的 needle `(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 在源码里仍只出现一次、在同一个模板字面量里（`taskOrgClauseWith`）；`buildTaskScopeCondition` 与 `buildTaskPendingCondition` 的输出快照逐字节不变，且其输出里 `tasks.org_id = $2` 仍恰一次；新加的注释里不出现这段 needle 文本；这样门 1 的单点 mutant 同时打掉新构造器（§11.6 有第二租户格）。
2. **不会有跨 org 收件人**：收件人只来自 `task_assignees` / `task_followers` / `task_list_members`（清单项写入时 PR-3a 已保证任务与清单同 org，producer 的清单扇出另带清单 org 子句；负责人 / 关注人 / 成员写入时的在职校验属 R17）；发送时再复核在职（§4.6）；身份解析限定 org；发送用的应用配置只取产生身份的那一行集成（§8.2 第 2 步），所以身份与应用属于同一个企业。同一用户在两个 org 各有设置行时收到两份汇总，各走各的 org 与集成。
3. **失去访问即跳过**：§7.4 每族都有 `recipient_lost_access`；`deleted` 族按软删行上仍存在的成员行判定。
4. **没有用户可控 URL**：payload、文案、日志里都没有 URL；出站主机只来自管理员写的集成配置，且限于 `https` 的钉钉域名（§8.5）；用户文本先经 `sanitizeTaskTextForMarkdown` 转义（§8.3、§11.4 有格）。
5. **日志卫生**：不写标题 / 正文 / token / 钉钉原文；`last_error` 只有固定码或先截后脱敏的文本；本通道的出站调用让传输层也不记上游原文（§8.5）。
6. **flag 严格 `'true'`**；全 OFF 时零行、零 claim、零注册（M4-d 格）。
7. **写放大有界**：D14 / A5 上界；producer 一条 INSERT。
8. **`tasks:admin` 不消费**（R18）；本件没有任何路由。
9. **不改中间件、不改 RBAC**。

---

## 11. 测试计划

### 11.0 格落在哪一行（`RULED(2026-10-07): [R01]`）

R01 已裁（2026-10-07，回复模板末句一并同意的部分），取推荐值的修订形：M4-a→门 23、M4-b→门 24、M4-c→门 8 子集、M4-d→门 25，门 18 / 1 / 17 / 20 / 15 各加 M4 新表面子集。这些新行还不在锁里：它们由一个只改锁的 Draft PR（#6248）写进锁的 `arm-set`，那个 PR 的合并另需 owner 点名；在它合并之前，下表的新行与本 PR 落在其中的格一律候选、未计分。

| 行（候选，未入锁） | 本 PR 的格 | 位置 |
|---|---|---|
| `M4\|23\|outbox`（M4-a） | 幂等、形状、事务回滚不留行、flag 关着零行、无活跃钉钉集成的 org 零行、空汇总行的形状 | `task-m4-outbox`、`task-m4-delivery`（空汇总形状格） |
| `M4\|24\|收件人`（M4-b） | 纯函数网格；真库：关注人收 `completed` 不收 `self_completed`、清单 reader 收 `commented`、他 org 清单的成员零行；N1 两格 | `task-notifications.test.ts`、`task-m4-outbox` |
| `M4\|8\|提醒与每日汇总`（M4-c） | 扫描窗、floor、同一时刻超过一页、缺省三格已在 PR-3a、汇总边界对拍、空汇总、当天后到的到期任务不补发 | `task-reminders.test.ts`、`task-m4-scheduler`、`task-m4-delivery` |
| `M4\|25\|调度单实例`（M4-d） | 一方取锁（跟随方的计数 job 零次）、`pg_locks` 判别式、`55P03`、leader 连接被终止后进程存活、两 worker 交错不重投（两个 mutant）、慢通道不耗尽次数、优先级、全 OFF 零 claim、helper 负控 | `task-m4-scheduler`、`task-m4-delivery` |
| 门 18 M4 子集 | 三条目 + 删一条即红 | manifest 测试（不改） |
| 门 1 M4 子集（候选） | worker 物化的第二租户格：门 1 的单点 org mutant 下必须变红 | `task-m4-delivery` |
| 门 17 / 20 / 15 子集 | 登记与收集数；harness；注释 | 验证 MD |

### 11.1 新的真库文件（每个：顶部 `assert-rbac-optional-off` import、`EXPECT_DB` 哨兵、独立 org 前缀、`afterAll` 清理、三处登记）

| 文件 | 切片 | 内容 |
|---|---|---|
| `task-m4-outbox.db.test.ts` | S2（S3 补 N1 两格） | producer 各触点；四族行形状与 payload 无用户文本；幂等；回滚；flag 关着零行；org 前提；收件人真库格；清单归档族；他 org 清单 |
| `task-m4-delivery.db.test.ts` | S4（修订 4 补格） | worker 协议：claim / 栅栏续租 / 退还 / 终态 / 清扫 / 毒行（含清单族与汇总族的 payload 不属于本行、被清扫的持有行读回）/ 退避；两 worker 交错；崩溃前后；超预算的行与其身后行的立即退还；租约在行下被改写时栅栏拒绝；慢通道；优先级；各族 skip 规则与 `event_stale`；在职复核；第二租户；空汇总形状（零通道调用）；发送时 floor 只计 floor 事件类型；1000 字符截断；变异 |
| `task-m4-scheduler.db.test.ts` | S5（修订 4 补格） | 提醒 tick（含跨页）、汇总 tick（含已离开 org 的设置行不写行）、leader 锁与计数 job、leader 连接被终止、半开的 leader 在空闲界限内失去后端（可冻结的中继）、心跳保持的长扫描与不心跳被结束的扫描、全 OFF、`W ≥ 2 × interval`、`stop()` 收尾（含投递行在 prepare 中时其余行先退还） |
| `task-m4-dingtalk.db.test.ts` | S6 | 身份解析各支与 org 限定；配置只取集成行；出站地址；token 后复核；发送分类；超时常量；转义；无网络 |

共用 helper（追加到 `tests/helpers/task-m4-fixtures.ts`，不进三集合）：`FakeTaskDeliveryChannel`（可编程：ok / retry / fail / skip / outcomeUnknown / 挂起到 deferred / 每次发送推进步进时钟 N 毫秒；用 spy 记录每次 `prepare` 与 `send` 的 `(deliveryId, workerId)`——终态 CAS 会清空 `claim_worker_id`，所以「哪个 worker 发的」只能从 spy 读）、`seedOutboxRow`、`steppedClock()`、`seedDirectoryBinding(orgId, userId, externalUserId, { integrationStatus, config })`（直接在**任务所在 org** 插 `directory_integrations` 行；产品的建集成路径把 org 写死为 `'default'`，不能用它造夹具）。

**行隔离**：org 前缀隔离不了 worker——claim 与两个清扫都跨 org，清扫也不分通道。`task-m4-delivery` 与 `task-m4-scheduler` 在 `beforeEach` 清空整张 `task_notification_deliveries`；lane 串行执行文件（`vitest.integration.config.ts:26-27`：`fileParallelism: false`、`maxConcurrency: 1`），所以不会影响别的文件。每格的断言只看本格播种或产生的行 id 与 spy 记录。

**时间控制**：worker 与调度器的 `now` 全部注入；SQL 里的 `now()` 只在事件默认值与汇总内容条件，对应格用相对播种；汇总格选一个固定偏移的时区，使数据库当前时刻落在当地的汇总窗口里，不需要等待越过午夜（修订 5 按实现更正，验证 MD S4.8 第 10 条）。**没有 sleep**：并发格用 deferred promise 控制 fake 通道的返回时机。

### 11.2 M4-a（outbox 幂等与形状）

- 同一事件对同一收件人调 producer 两次 ⇒ 一行；`RETURNING` 计数第二次为 0。
- 缺 `org_id` 插入 ⇒ 23502；`recipient_role='observer'` ⇒ 23514；`status='outcome_unknown'` 可插入（PR-3a `task-m4-schema` 已有，本文件只引用不复制）。
- handler 事务回滚（模拟事件后抛错）⇒ 无 outbox 行。
- 三个 flag 任一不为 `'true'` ⇒ 完成 / 评论 / 删除 / 归档都零行；三者全开 ⇒ 有行。
- org 前提：三开关全开，org 甲没有钉钉集成行、org 乙只有非活跃集成 ⇒ 两者的完成 / 评论 / 归档与两个扫描都零行；org 丙有活跃集成 ⇒ 有行（正控）；负控：`resolveTaskDeliveryChannelsForOrg` 恒返回全部通道 ⇒ 甲、乙的零行格红。
- 空汇总行的形状（位于 `task-m4-delivery`，R07 v2 要求的形状格）：`source_type='task_daily'`、`source_id` 为收件人、`recipient_role='assignee'`、`payload` 恰为 `{ kind, date, timeZone }`、`status='skipped'`、`last_error='empty_digest'`、`delivered_at IS NULL`、`redelivery_safe=false`、`attempt_count=1`。
- 负控：去掉 `ON CONFLICT` ⇒ 第二次 23505。

### 11.3 M4-b（收件人集合）

- 纯函数：角色子集 × 事件闭集与钉死表相等；排除 actor；优先级去重（任务 D 已有，最终 head 上重跑）。
- 真库：关注人在 `completed` 收到一行、在 `self_completed` 零行；清单 `read` 成员在 `commented` 收到一行，`recipient_role='list_member'`；一人兼创建人与清单成员只一行且 `creator`；已归档清单的成员照收；actor 零行。
- 他 org 清单（修订 2 更正播种方式）：先证明库拒绝一条清单与任务不同 org 的清单项（组合外键，23503）；再在一个超级用户连接上暂停外键检查写入这样一行（org 乙的清单含 org 甲的任务，与 PR-3a `task-m4-list-roles` 的跨 org 清单项格同法）；在该任务上产生通知 ⇒ org 乙清单的成员零行，org 甲清单的成员照收；负控：清单 org 单点恒真（`task-list-access.ts` 的私有生成器）⇒ org 乙清单的成员收到一行 ⇒ 红；只让新构造器绕过该生成器的变异同样变红（验证 MD S2 变异表）。
- N1（S3）：`all` 模式删掉唯一未完成负责人 ⇒ 任务 done、有 `completed` 事件、关注人收到完成通知；给已完成 `all` 任务加人 ⇒ open、`reopened`、关注人收到重启通知。
- 负控：删 actor 排除 ⇒ 红；优先级改成 follower 优先 ⇒ `recipient_role` 断言红。

### 11.4 提醒（M4-c 的一半）与文案

- 扫描：`remind_at` 在 `(now−W, now]` 且 `≥ floor` ⇒ 入队；`≤ now−W` ⇒ 不入队；写入时已过去（floor > remind_at）⇒ 不入队；无事件行 ⇒ 不入队；已完成 / 已软删 ⇒ 不入队；同一任务两个 tick ⇒ 一行；改期后 ⇒ 新键，旧行发送时 `reminder_stale`。
- 跨页（`ASSUMPTION(task-m4): [own-3b-15]`）：注入页大小 5，12 个任务 `remind_at` 相同、按 id 排在最前的 3 个 floor 不满足 ⇒ **一个** tick 入队 9 个；再用默认页大小跑一格：501 个任务同一时刻到点 ⇒ 一个 tick 全部入队。负控：去掉键集游标（恢复修订前的固定 `LIMIT`）⇒ 两格都红。
- 收件人：两个负责人一个已完成 ⇒ 只给未完成的；零负责人 ⇒ 创建人、`creator`；关注人零行。
- worker：任务在 tick 后完成 ⇒ `skipped/reminder_stale`；worker 停机超过 W（步进时钟）⇒ `reminder_window_elapsed`。
- 文案：`sanitizeTaskTextForMarkdown('[点我](https://x)')` 的输出不含 `](`、不含换行；标题含 `#` 不成为 markdown 标题；负控：去掉转义 ⇒ 红。
- 这一节各负控落在哪一格，见 §11.9 的对照表（窗口项有两份：扫描 SQL 的候选界与 TS 的判定，分别由不同的格钉住）。

### 11.5 每日汇总（M4-c 的另一半）

- 到点：用户时区 `Asia/Shanghai` 与 `Pacific/Kiritimati` 各一，注入 `now` 使一方在窗内一方在窗外 ⇒ 只给窗内的写行，`date` 是各自当地日期。
- 一天一行：窗内两个 tick ⇒ 一行；次日再一行。
- 迟到：`now` 在 `sendAt + W` 之后 ⇒ 不写行（S5）；行已写但 worker 迟到 ⇒ `digest_window_elapsed`（S4）。
- 空汇总：`now = sendAt` 跑 tick 与 worker，用户无到期任务 ⇒ 行终态 `skipped`、`last_error='empty_digest'`、fake 通道零调用（物化先于 prepare，`[own-3b-37]`）。
- 当天后到的到期任务（R07 v2 的那一格，时刻钉死在窗内）：接上一格，`now = sendAt + 30 分钟`（仍在 `[sendAt, sendAt + W)` 之内，所以窗口本身挡不住第二次写）播种一个今天截止的任务，再跑 tick 与 worker ⇒ 仍只有一行、零发送。负控：把 worker 的空汇总终态写换成「删除这一行」（即当天不留标记）⇒ 第二次 tick 写出新行并发送 ⇒ 红。
- 内容：逾期 / 今天 / 明天各一条入选，后天不入选，本人已完成的 `all` 任务不入选，`status='done'` 不入选；`TASK_DIGEST_MAX_ITEMS + 3` 条 ⇒ 正文含「另有 3 项」。
- TS/SQL 对拍：同一批相对 DB `now()` 播种的任务，`buildTaskDailyDigestCondition` 的行集 == `isInDailyDigest(row, dbNow, tz)` 为真的集合；负控：SQL 的 `+ 1` 改 `+ 2` ⇒ 红。
- 设置：`daily_reminder_enabled` 关掉后 worker ⇒ `digest_settings_changed`；时区改变同上。

### 11.6 M4-d（调度单实例）与 worker 并发

- 取锁（`task-m4-scheduler`）：连接 A 直发 `pg_advisory_xact_lock(hashtext('tasks-scheduler:leader'))`（harness 直发不受门 7 禁令）；调度器的扫描 job 换成**计数 job**；`scheduler.runTick()`（`lockTimeoutMs=1500`）⇒ `{ leader: false, reason: 'lock_busy' }` **且计数 job 运行 0 次**；等待期间第三连接按锁 §6.4 的判别式看到 `granted=false` 且 `wait_event_type='Lock'`、`wait_event='advisory'`（settle：轮询到稳定或 deadline）；A 提交后再 `runTick()` ⇒ leader 且计数 job 恰运行 1 次。
- `lock_timeout` 实证：B 的等待以 SQLSTATE `55P03` 结束，耗时接近 `lockTimeoutMs`（上界 `lockTimeoutMs + 1000`，无下界断言）。
- 负控（照门 6 与裁决包 M4-d）：`cp` 备份 `db/task-advisory-locks.ts`，注释掉 `acquireTasksSchedulerLeaderLock` 体内取锁行（`runSourceMutant`，先断言 needle 唯一），A 持锁时 `runTick()` 报 leader、计数 job 运行 1 次 ⇒ 红。
- leader 连接被终止（`task-m4-scheduler`，`ASSUMPTION(task-m4): [own-3b-23]`）：`connectLeaderClient` 用真 pg 客户端；扫描 job 挂在 deferred 上时，第三连接对 leader 客户端的后端 `pg_terminate_backend` ⇒ `runTick()` 以 `reason: 'leader_client_lost'` 结束，job 观察到 `leaderLost()` 为真，gauge 为 `relinquished`，测试进程没有未处理的 `error`；下一次 `runTick()` 重新成为 leader。负控：去掉 `client.on('error', …)` ⇒ vitest 记到未处理错误 ⇒ 红。
- 两 worker 交错（`task-m4-delivery`）：10 行 pending（同一 `next_attempt_at` 与 `created_at`，顺序由 id 决定）；两个 worker 的 `batchSize` 都是 5。固定的交错：① worker 1 `runBatch()`，claim 5 行，第一行的 `prepare` 挂在 deferred d1 上；② worker 2 `runBatch()`，claim 5 行，对它的第一行过栅栏后 `send` 挂在 deferred d2 上；③ 放行 d1，worker 1 跑完；④ 放行 d2，worker 2 跑完。断言：spy 里每个 deliveryId 恰被 `send` 一次；两个 worker 各 5 次；10 行全部 `sent` 且 `attempt_count = 1`；两次 `runBatch` 的 `lostLease = 0`。负控一：删 claim 的租约谓词 ⇒ 第 ② 步 worker 2 claim 到的是 worker 1 手里那 5 行（`attempt_count = 2`；第 ③ 步 worker 1 `lostLease = 5`；另外 5 行无人发送）⇒ 红。负控二：在负控一之上再把栅栏的 `WHERE` 削到只剩 `id`（去掉状态、持有者、次数、租约四个合取）⇒ 第 ③ 步 worker 1 对 worker 2 正在发送的那一行再过一次栅栏并发送 ⇒ spy 里同一 deliveryId 出现两次 ⇒ 红。负控二说明真正挡住重发的是栅栏 CAS（其中的状态合取），而不是 claim 的租约谓词；也说明为什么只删租约谓词的负控不能用「总调用次数 > 行数」来判。
- 崩溃前：worker 1 的 `prepare` 挂起（deferred），步进时钟越过批租约，worker 2 claim 并发送 ⇒ 1 次调用；释放 deferred 后 worker 1 的栅栏 CAS 为 0 行 ⇒ 不发送，结果 `lost-lease`；总调用仍 1 次。
- 崩溃后：worker 1 过栅栏后 `send` 挂起，步进时钟越过 `sendLease`，worker 2 的清扫把行写成 `outcome_unknown` 且**不**发送；释放 deferred（返回 ok）后 worker 1 的终态 CAS 为 0 行；行仍 `outcome_unknown`；负控：把清扫改成回到 `pending` ⇒ worker 2 再发一次 ⇒ 红。
- 慢通道不耗尽次数（`ASSUMPTION(task-m4): [own-3b-08]`）：12 行，`batchSize = 5`，批租约 60s，fake 通道每次发送把步进时钟推进 12 秒（每次都成功）。worker 的 `budgetMs`、`deadline` 与每行预留判断都读注入的 `now`，不读墙钟；本格给 `runUntilIdle` 一个足够大的 `budgetMs`（10 分钟），或循环调用直到某批 claim 为 0 ⇒ 12 行全部 `sent`、每行 `attempt_count = 1`、没有任何行 `attempts_exhausted`，且至少一批的 `released > 0`（按上面的数字，每批在第 3 行之后剩余租约不足 30 秒，其余退还）。负控：退还不减次数（或不退还、等租约过期）⇒ 被退还过的行 `attempt_count ≥ 2` ⇒ 红。
- 优先级：先播种 60 行 `task_event`（较早的 `next_attempt_at`），再播种 1 行 `task_reminder` ⇒ 第一批（50 行）就含这条提醒并发出。负控：去掉 claim 排序里的优先项 ⇒ 第一批不含它 ⇒ 红。
- 事件新鲜度：`task_event` 行 `created_at = now − 25h` ⇒ `skipped/event_stale`、零发送；`now − 23h` ⇒ 发送（正控）；清单族同。负控：去掉新鲜度检查 ⇒ 红。
- 停机：`runUntilIdle` 进行中、第一行过栅栏后置 `stopping` ⇒ 本批其余行被退还（次数回退、租约清空），不再有新的栅栏；已过栅栏的那一行完成终态写。修订 4 补格（`task-m4-scheduler`）：真调度器、投递 job 的第一行阻塞在 `prepare`、`stop()` 宽限 300 ms ⇒ `stop()` 返回时其余四行已经 `pending`、次数 0、无持有者；阻塞的那一行返回后也退还；零发送。负控：去掉在飞期间的立即退还 ⇒ `stop()` 返回时其余行仍被持有 ⇒ 红。
- 半开的 leader（修订 4，`task-m4-scheduler`）：A 经一个可冻结的 TCP 中继连接数据库并领导（空闲界限注入为 1.5 s），扫描挂在 deferred 上；冻结中继（两个方向都不再转发、也不传播关闭）；B 的 tick 是 `lock_busy`；在界限 + 3 s 内 `pg_stat_activity` 里 A 的后端消失；B 的下一个 tick 领导、扫描运行一次；关闭中继后 A 的监听把 leader 标为丢失，A 的 tick 以 `leader_client_lost` 结束。另一格：空闲界限 1.5 s 下，一个 3 s 的扫描每 500 ms 心跳一次 ⇒ tick 正常提交；同样的扫描不心跳 ⇒ 服务端结束会话、tick 以 `leader_client_lost` 结束。负控：去掉 `SET LOCAL idle_in_transaction_session_timeout` ⇒ 前一格等待超时、后一格的不心跳扫描不被结束 ⇒ 红；心跳不发语句 ⇒ 心跳格的扫描被结束 ⇒ 红。
- 超预算的行（修订 4，`task-m4-delivery`，注入的定时器）：A claim 两行，第一行阻塞在 `prepare`，第二行（已到第 5 次）排在它后面；触发预算定时器 ⇒ 第二行立即退还（`pending`、次数 4、无持有者），第一行仍被 A 持有；B 的一批清扫到零行、claim 第二行（次数 5）并发出；时钟推进 16 s 后放行 A 的 prepare ⇒ 第一行不过栅栏、`retrying / row_budget_exceeded`、次数 1。负控：定时器不触发退还 ⇒ 第二行一直被持有 ⇒ 红；预算检查关闭 ⇒ 第一行被发出 ⇒ 红。
- 第二租户（门 1 M4 子集候选）：org 甲的 outbox 行 `source_id` 指向一个真实存在于 org 乙的任务 ⇒ `task_missing`、零发送；同形再做一格清单族 ⇒ `list_missing`。负控：门 1 的单点 org mutant（替换 `task-access.ts` 里那一处 needle）⇒ 任务格红；PR-3a 的清单 org mutant ⇒ 清单格红。
- 全 OFF：三个 flag 都不设时 `startTaskScheduler()` 返回 `null`、`createTaskDeliveryChannelsFromEnv()` 为空、直接构造的 worker 对 pending 行 `runBatch()` 零 claim（注册通道为空）。
- 毒行：`attempt_count = maxAttempts` 且租约过期 ⇒ 清扫 `failed/attempts_exhausted` 且 `redelivery_safe = true`；`payload` 非对象 ⇒ `failed/payload_invalid` 一次即终。
- 退避：可重试失败 ⇒ `retrying` 且 `next_attempt_at = now + 60s`；第 5 次 ⇒ `failed` 且 `redelivery_safe = true`；`outcomeUnknown` ⇒ 终态、步进时钟后不再被 claim；`skip` ⇒ `skipped`。

### 11.7 钉钉通道（S6，无网络）

- 身份各支各一格：该 org 无任何钉钉集成行 ⇒ `skipped/dingtalk_org_integration_missing`；只有非活跃集成 ⇒ `skipped/dingtalk_org_integration_inactive`（零次重试）；有活跃集成但本人未绑定 ⇒ `skipped/dingtalk_recipient_not_bound`；两行 ⇒ `failed/dingtalk_recipient_ambiguous`；`external_user_id` 空 ⇒ `skipped`。
- 跨 org：同一本地用户只绑在 org 乙的集成，org 甲（有活跃集成）的行 ⇒ `dingtalk_recipient_not_bound`，fake sender 零调用；负控：去掉 join 里的 `i.org_id = $2` ⇒ 红。
- 配置来源：进程环境里另有一套应用凭据（应用 Y），集成 X 的行存了自己的 `appKey` / `workNotificationAgentId` ⇒ sender stub 收到的是 X 的 appKey 与 agentId。负控：通道配置改为从进程环境读取、而不是从身份所在的集成行读取 ⇒ 红。集成行缺 agentId ⇒ `retrying/dingtalk_config_unavailable`，token stub 零调用。
- 出站地址：集成 `baseUrl` 为 `http://oapi.dingtalk.com`、`https://evil.example` ⇒ `failed/dingtalk_base_url_rejected`，token 与 sender stub 零调用；`https://oapi.dingtalk.com` 与缺省 ⇒ 正常。
- token 后复核：两次身份查询之间改掉绑定 ⇒ `retrying/dingtalk_destination_changed`，零发送。
- 发送分类：token 失败 ⇒ `retrying`；`DingTalkTimeoutError`（`outcomeUnknown`）⇒ `outcome_unknown`；`DingTalkBusinessError` errcode 90018 ⇒ `retrying`；4xx `DingTalkRequestError` ⇒ `failed`；栅栏后抛出普通 `new Error('x')` ⇒ `outcome_unknown`（负控：恢复「其余可重试」⇒ 红）；返回体无 `task_id` ⇒ `outcome_unknown`。
- 超时常量：stub 断言发送与 token 调用收到的 `options.timeoutMs` 等于 `TASK_DINGTALK_REQUEST_TIMEOUT_MS`；token 调用不带 `signal`（prepare 预算由通道自己与 token 请求竞速，§8.2 第 4 步）；两次调用都带 `logUpstreamMessage: false`（§8.5）（修订 5 按修订 4 的实现更正）。
- `prepare` 与 `send` 之间的栅栏：sender stub 记录调用时刻晚于栅栏 UPDATE。

### 11.8 单测

- `task-reminders.test.ts`（追加）：扫描条件文本快照（含键集游标）、`computeDailyDigestSendAt` 三时区、`isDailyDigestDue` 边界（`sendAt−1ms` 假、`sendAt` 真、`sendAt+W−1ms` 真、`sendAt+W` 假）。
- `task-notification-text.test.ts`：同一任务两条 `commented` 行（不同 deliveryId）渲染出不同正文；完成→重启→完成三行渲染互不相同；标签只含十六进制与固定前缀；负控：去掉标签 ⇒ 红。
- `task-delivery-protocol.test.ts`：分类真值表（含 `fenced` 为真时「无法归类 ⇒ outcome_unknown」）、退避阶梯、夹取、`orderClaimedDeliveries` 与 claim 排序键一致、`isTaskEventNotificationStale` 边界、`isAllowedTaskDingTalkBaseUrl` 真值表（协议、主机、以 `oapi.dingtalk.com` 开头而不以 `.dingtalk.com` 结尾的主机如 `oapi.dingtalk.com.example`、`'x'`）、`TASK_DELIVERY_DEFAULTS` 满足 `leaseMs > TASK_DELIVERY_ROW_RESERVE_MS`。
- `task-notification-flags.test.ts`（`'true'` / `'TRUE'` / `' true'` / 缺失）。
- `task-notifications.test.ts`（追加）：四个 `plan*` 的行形状、payload 无标题。
- `task-access.test.ts`（追加，S4）：`buildTaskByIdAnyStateCondition` 的文本与参数；既有 `buildTaskScopeCondition` / `buildTaskPendingCondition` 快照逐字节不变；needle 在源码里恰一次。`task-list-access.test.ts`（追加，S2）：`buildTaskListsOfTaskCondition` 的文本。
- `task-membership.test.ts`（S3）：N1 两格 + 既有断言更新。
- 门 20 harness、三集合枚举、manifest 测试、payload 台账守卫：不改，跑绿。

### 11.9 变异对照表（每个 mutant 只在一次性检出里跑，PR-3a §10.1 的规则）

| mutant | 必须变红的格 | 位置 |
|---|---|---|
| 删 actor 排除；优先级改 follower 在前 | M4-b 纯函数与真库格 | §11.3 |
| 去掉 `ON CONFLICT` | 幂等格（23505） | §11.2 |
| org 前提恒真 | 无集成 org 零行格 | §11.2 |
| 清单扇出去掉清单 org 子句 | 他 org 清单格 | §11.3 |
| 去掉扫描的键集游标 | 跨页两格 | §11.4 |
| `buildTaskReminderScanCondition` 的窗口下界去掉（SQL 侧） | 扫描格「`≤ now−W` 不入队」 | §11.4 |
| `isTaskReminderDue` 的窗口项去掉（TS 侧） | worker 格「停机超过 W ⇒ `reminder_window_elapsed`」（扫描 SQL 已先挡掉早于 W 的行，扫描格看不见这一项） | §11.4 |
| `isTaskReminderDue` 的 floor 项去掉 | 扫描格「写入时已过去 ⇒ 不入队」（floor 只在 TS 判） | §11.4 |
| `isReminderSkippedByTaskState` 旁路 | worker 格「tick 后完成 ⇒ `reminder_stale`」 | §11.4 |
| 汇总 SQL 的 `+ 1` 改 `+ 2` | TS/SQL 对拍格 | §11.5 |
| 空汇总终态改为删除该行 | 「当天后到的到期任务」格 | §11.5 |
| 注释掉取锁行 | 取锁格（计数 job 运行 1 次） | §11.6 |
| 去掉 leader 客户端的 `error` 监听 | leader 连接被终止格 | §11.6 |
| 删 claim 的租约谓词 | 两 worker 交错格（`attempt_count`、`lostLease`、未发送行） | §11.6 |
| 上一条 + 栅栏只剩 `id` | 两 worker 交错格（同一行发送两次） | §11.6 |
| 清扫把 `sending` 改回 `pending` | 崩溃后格 | §11.6 |
| 退还不减次数 | 慢通道格 | §11.6 |
| 去掉 claim 优先项 | 优先级格 | §11.6 |
| 去掉事件新鲜度检查 | 事件新鲜度格 | §11.6 |
| 门 1 单点 org mutant；PR-3a 清单 org mutant | 第二租户两格 | §11.6 |
| 身份 join 去掉 `i.org_id = $2` | 跨 org 格 | §11.7 |
| 通道配置改从进程环境读取 | 配置来源格 | §11.7 |
| 栅栏后「其余」改回可重试 | 发送分类格（普通 `Error`） | §11.7 |
| 去掉正文标签 | `task-notification-text` 单测 | §11.8 |
| 去掉转义 | 文案格 | §11.4 |
| 汇总扫描按 org 的阶段里不心跳；组前先看 stopping / lost 再心跳（修订 6） | 按 org 阶段超过界限的真库格；组内心跳失败的单测格 | §11.6 |
| `stop()` 在宽限之后才 abort 停机信号（修订 6） | 停机退还格（`stop()` 返回前其余行已退还） | §11.6 |
| 三处每行预算检查各去掉一处；发送用第一次物化的文案（修订 6） | 三处各一格；改名格 | §11.6 |
| 值表去掉 agent id / 标题；截断落在代理对中间（修订 6） | 通道单测 | §11.7 |

### 11.10 回归

M2 / M3 / PR-3a 的全部真库文件与鉴权门在最终 head 上重跑；flag 全 OFF 下 M2/M3 的请求路径行为逐字节不变（`task-p0a`、`task-m3-*` 原样绿）。完整的门行回归按 R01 ③ 记在 PR-3c。

---

## 12. `ASSUMPTION(task-m4)` 全表

依赖裁决包条目的（修订 2：「状态」列按 2026-10-07 的裁决；本 PR 收到的已裁清单为 R05（细则按 D13，不含 R05-opt）、R06、R07、R08、R09、R16、R17、R19、R21、R22、R23、N1 与 [own-53]；修订 3 起另含 R01、R04、R13；修订 5 把只在 §10 引用的 R18 补进下表。2026-10-07 的裁决覆盖 R01–R23、N1、N2，下表只列本 PR 的取值或引用所及的各条）：

| 标签 | 状态 | 内容 | 位置 |
|---|---|---|---|
| `[R05]` `[D13]` | `RULED(2026-10-07)`（R05 按 D13 的细则；不含 R05-opt） | 触发闭集、四值角色、优先级去重、排除 actor、清单成员含已归档、清单归档通知创建人、提醒 / 汇总记 `assignee`（零负责人 `creator`）、发送时复核在职 | producer、worker |
| `[R06]` | `RULED(2026-10-07)` | 扫描窗 W=2h、floor 取最近 `created`/`remind_changed`、不补发、到点时状态复核、改期换键、收件人为尚未完成的负责人，任务没有负责人时为创建人 | §6.2、§7.4 |
| `[R07]` | `RULED(2026-10-07)` | 汇总 = 逾期 ∪ 今天与明天截止的任务；按收件人的 `time_zone` 在 09:00；一天一行，空则一行 skipped、不发送（由谁写这一行仍是本件自选 `[own-3b-03]`，§13-Q5） | §6.3、§7.4 |
| `[R17]` | `RULED(2026-10-07)` | 发送时在职复核，不在职即 skipped | §4.6 |
| `[N1]` | `RULED(2026-10-07)` | 增删负责人致翻转时追加 `completed`/`reopened`，actor 为操作者 | §5.5 |
| `[R23]` | `RULED(2026-10-07)` | outbox 行 id 用 uuid（列缺省值；producer 的 INSERT 不写 id） | §5.3 |
| `[R08]` `[R09]` `[R16]` `[R18]` `[R19]` `[R21]` `[R22]` | `RULED(2026-10-07)` | 本件不改它们落在的面：关注人能力、红点归属、socket（PR-3c）、`tasks:admin` 不旁路、清单动态读、DML 普查闸、待办中心 registry；本件只在 §4.3 / §10 引用 | — |
| `[R01]` | `RULED(2026-10-07)` | 门行按修订形落整数门号：M4-a→23、M4-b→24、M4-c→门 8 子集、M4-d→25；新行由只改锁的 PR（Draft #6248）写进锁，那个 PR 合并之前候选未计分 | §11.0 |
| `[R04]` | `RULED(2026-10-07)` | `tasks.org_id` 只经 `task-access.ts` 的一个私有生成器发射；按 id 取任务经 `buildTaskByIdCondition`；worker 的任务读都经单点构造器（本件新增的 `buildTaskByIdAnyStateCondition` 不在 R04 之内，是 `[own-3b-17]`，§13-Q14） | §3.4、§7.4、§10 |
| `[D8]` | `ASSUMPTION(task-m4)` | `task_lists.org_id` 只经 `task-list-access.ts` 的一个私有生成器发射；清单读与清单成员扇出都经它（`buildTaskListByIdCondition`、`buildTaskListsOfTaskCondition`） | §5.3、§7.4、§10 |
| `[R13]` | `RULED(2026-10-07)` | M4 不做硬删，保留期另行裁定；因此 M4 没有清理作业，outbox 行一直保留（manifest `purpose` 与 PR body 照写） | §1、§5.1、§9.2 |
| `[D1]` | `ASSUMPTION(task-m4)` | 表形沿用 PR-3a；不加列 | §2 |
| `[D3]` | `ASSUMPTION(task-m4)` | leader 锁常开；interval 不是开关（S1 起作为数值旋钮登记 manifest，见验证 MD S1.7 第 1 条） | §6.1、§9.1 |
| `[D4]` | `ASSUMPTION(task-m4)` | 钉钉通道只在 flag 为 `'true'` 时注册；收件人没有可用的钉钉绑定一律记 skipped 与固定码：有活跃集成而未绑定 ⇒ `dingtalk_recipient_not_bound`；只有非活跃集成 ⇒ `dingtalk_org_integration_inactive`；org 没有任何钉钉集成行 ⇒ `dingtalk_org_integration_missing` | §8.1、§8.2 |
| `[D12]` | `ASSUMPTION(task-m4)` | 不新增 Intl 调用点 | §3.4 |
| `[D14]` | `ASSUMPTION(task-m4)` | 单事件扇出上界 `1 + 50 + 50 + 100 × 10`（清单成员 ≤ 100、单任务所属清单 ≤ 10，负责人 / 关注人各 50 取自 A5） | §5.1、§5.3、§6.4 |

注：修订 2 曾因本 PR 收到的已裁清单没有点名 R01、R04、R13 而把它们留作假设（§13-Q21）。答复是三条都在 2026-10-07 的裁决里（回复模板对 R02–R23 的批准含 R04、R13，模板末句含 R01），修订 3 改了标签，取值不变。包内默认约束（`[Dxx]`）除 R05 点名的 D13 之外都仍是假设。

本件自己的取舍：

| 标签 | 内容 |
|---|---|
| `[own-3b-01]` | 投递线未全开时 producer 与两个扫描一行不写（关闭期间的新事件不补发）；已写下的行不受开关影响，由 `[own-3b-14]` 的新鲜度规则处理 |
| `[own-3b-02]` | 汇总迟到上限 = W；窗外不补 |
| `[own-3b-03]` | 汇总内容在发送时算，空汇总由 worker 记终态 |
| `[own-3b-04]` | `sending` = 效果栅栏，栅栏同时把租约续成 `sendLease`；过期 `sending` ⇒ `outcome_unknown`，永不重发；claim 不改 status 只写租约；栅栏后无法归类的错误 ⇒ `outcome_unknown`；批内没轮到的行退还且次数回退 |
| `[own-3b-05]` | 各族的 send 前 skip 规则与固定错误码；`deleted` 族经 `buildTaskByIdAnyStateCondition` 读软删行 |
| `[own-3b-06]` | 调度器与 worker 都要求 `TASKS_ENABLED='true'` |
| `[own-3b-07]` | 投递由赢得本 tick 的实例在 leader 事务提交之后运行，不在持锁事务里；并发安全来自 `SKIP LOCKED` 与栅栏 CAS |
| `[own-3b-08]` | 常量：interval 60s（env 旋钮夹到 `[5s, W/2]`，修订 4 起；构造函数校验同一区间）、lock_timeout 1s、leader 会话空闲界限 30s 与扫描心跳组 50 个 org（`[own-3b-35]`）、每行预算 15s（`[own-3b-36]`）、batch 50、批租约 60s、maxAttempts 5、钉钉单次请求超时 10s、prepare 预算 12s 与物化余量 3s（修订 6）、栅栏余量 5s（`sendLease` 15s）、每行预留 30s、每 tick 投递预算 40s、stop grace 8s、扫描页大小 500、汇总条目上限 20 |
| `[own-3b-09]` | outbox 行不存用户文本；文案发送时生成并转义；不带 deep link；不显示操作者姓名 |
| `[own-3b-10]` | tick 用 DB `now()` 锚定的时钟；文案里的截止时间按四列原样显示 |
| `[own-3b-11]` | 三个指标：leader gauge、投递结果 counter、积压 gauge |
| `[own-3b-12]` | `writeEvents` / `writeMembershipEvents` 返回写入的事件（签名扩展） |
| `[own-3b-13]` | producer 与两个扫描只为有活跃钉钉集成的 org 写行 |
| `[own-3b-14]` | 事件族与清单族的发送时新鲜度 24 小时，超过记 `skipped/event_stale`；对已写下的行，关开关是暂停 |
| `[own-3b-15]` | 提醒扫描在一个 tick 内用 `(remind_at, id)` 键集游标排空窗口；floor 与窗口的判定留在 TS |
| `[own-3b-16]` | claim 先取有时间窗的两族（`task_reminder`、`task_daily`） |
| `[own-3b-17]` | `task-access.ts` 的私有 org 生成器改为带参数，新增 `buildTaskByIdAnyStateCondition`（任务 B 模块，需 owner 确认） |
| `[own-3b-18]` | 身份 0 行的三分，三支都记 skipped、固定码各不相同：无集成行 `dingtalk_org_integration_missing` / 只有非活跃集成 `dingtalk_org_integration_inactive` / 有活跃集成而未绑定 `dingtalk_recipient_not_bound`（D4 的推荐值；分码只为便于排查） |
| `[own-3b-19]` | 发送配置只取产生身份的那一行集成；缺配置 retryable |
| `[own-3b-20]` | 正文末行是逐行唯一的标签（outbox 行 id 前 8 位） |
| `[own-3b-21]` | 出站地址限 `https` 且主机为 `oapi.dingtalk.com` 或 `*.dingtalk.com` |
| `[own-3b-22]` | manifest 三条目：`dependsOn` 只是文档，`rules` 不写 |
| `[own-3b-23]` | leader 用专用客户端并全程挂 `error` 监听；失去连接即放弃本 tick，不跑投递 |
| `[own-3b-24]` | 批租约夹取 `[60 s, 600 s]`，下界为每行预留的两倍（S1 新增，验证 MD S1.7 第 7 条） |
| `[own-3b-25]` | 文案细节：汇总条目行的形式、截止时间接受 `HH:MM` 与 `HH:MM:SS` 且零秒显示 `HH:MM`、时区名转义（S1 新增，验证 MD S1.7 第 10 条） |
| `[own-3b-26]` | worker 在构造时读一次 `TASKS_ENABLED` 与自己的开关；不都为 `'true'` 时不发任何语句（S4） |
| `[own-3b-27]` | payload 必须属于本行（kind = `source_type`、任务 / 清单 id = `source_id`、汇总行 `source_id` = 收件人），否则 `failed / payload_invalid`（S4） |
| `[own-3b-28]` | 发送时读不到提醒 floor ⇒ `reminder_window_elapsed`，不发（S4） |
| `[own-3b-29]` | worker 自身步骤的固定错误码；`last_error` 从不写异常文本（S4；修订 4 加 `row_budget_exceeded`） |
| `[own-3b-30]` | tick 的第五种结果 `leader_unavailable`（S5） |
| `[own-3b-31]` | 积压 gauge 三值的口径（S5） |
| `[own-3b-32]` | 提醒扫描页大小可注入、整页末行与上一页相同即停（S5） |
| `[own-3b-33]` | 投递 worker 在启动时构造一次，每次运行交给它本 tick 的时钟（S5） |
| `[own-3b-34]` | 错误文本的格式与脱敏范围：栅栏前只有固定码，栅栏后「码: 脱敏文本」（S6；修订 4 的顺序与规则见 `[own-3b-40]`） |
| `[own-3b-35]` | leader 事务 `SET LOCAL idle_in_transaction_session_timeout` = 30 s；扫描每页之前、以及页内每再读一组至多 50 个 org 之前在 leader 连接上心跳，先心跳再看 stopping / lost（修订 6）；心跳失败按连接丢失处理（修订 4，§6.1） |
| `[own-3b-36]` | 每行预算 15 s（prepare 预算 12 s + 物化余量 3 s，严格大于 prepare 预算，修订 6）：第一次物化后超预算不调通道、prepare 后超预算不再读状态、再物化后超预算不过栅栏，都是 `retrying / row_budget_exceeded`；一行超预算时其余未开始的行立即退还（修订 4，§7.2） |
| `[own-3b-37]` | 物化先于 prepare（会被跳过的行不调通道）、栅栏前再物化一次（修订 4，§7.4） |
| `[own-3b-38]` | 汇总扫描按 org 应用一次发送时的在职判据，已离开 org 的设置行不写行（修订 4，§6.3） |
| `[own-3b-39]` | interval 上限 W/2，构造函数校验而不夹取（修订 4，§6.2） |
| `[own-3b-40]` | 错误文本先截到 4096 再处理、截断落在值内时连前段一起丢、值从长到短去掉、规则加宽到 user-info / IPv4 / 引号密钥对 / Bearer / C1 与 Unicode 格式字符；本通道的出站调用带 `logUpstreamMessage: false`（修订 4，§8.5）；值表含 agent id，两次截断不落在代理对中间，已知限制按规则列出（修订 6，§8.5） |

修订 4 另有一条已裁的规则：

| 标签 | 状态 | 内容 | 位置 |
|---|---|---|---|
| 正文用户文本的冒号规则 | `RULED(2026-10-09)` | 正文里的用户文本把 ASCII `:` 渲染为全角 `：`，在转义之前应用；固定部分保持原样 | §8.3 |

---

## 13. 只有 owner 能答的问题

修订 5 复核（2026-10-09）：Q1、Q11、Q21 已由 2026-10-07 的裁决答复；其余各题仍待答，本 PR 一律按题中的缺省交付（Q23 与 Q24 是修订 4 新增的，缺省都是不改）。

1. ~~N1 归 PR-3b，并同意改任务 C 的 `task-membership.ts`~~ **已裁（2026-10-07）**：N1 落槌，S3 必做（§5.5）。
2. **投递保证取「不重复发送」**：过期的 `sending` 终态为 `outcome_unknown`，不重发；崩溃在栅栏前的行可重 claim。备选：照考勤的过期重发（at-least-once，可能重复）。缺省：本件形状。是否要额外加状态机触发器（新 DDL）另答。
3. **flag 关着时不写行**（`[own-3b-01]`），**已写下的行按发送时新鲜度处理**（`[own-3b-14]`：事件族与清单族 24 小时）。备选：总是写行；或换一个新鲜度值；或已写下的行完全暂存、不设新鲜度。缺省：不写 + 24 小时。
4. **汇总迟到上限 = W**（`[own-3b-02]`）。备选：当天任何时刻补发。缺省：W。
5. **汇总内容在发送时计算**（`[own-3b-03]`），`empty_digest` 由 worker 写。备选：tick 侧计算并把任务 id 写进 payload。缺省：发送时。
6. **文案不带 deep link、不带操作者姓名**（`[own-3b-09]`）。要带链接需要 `PUBLIC_APP_URL` 与一个新 flag（进 manifest）；缺省：不带。
7. **`outcome_unknown` 的人工核对路径**：本件只留数据库查询；是否要一条只读账本接口（新路由，需门 1/2/13 计分）。缺省：不做。
8. **staging 真投递**（R01 ④）：需要 runner 加三个 flag 的输入（共享 workflow，本 PR 不改）、钉钉凭据、目录绑定；由哪一个 PR 改 runner。缺省：不在 PR-3b。
9. **`TASKS_ENABLED` 作为三个 flag 的前提**（`[own-3b-06]`）与 **投递在锁提交之后、由本 tick 的 leader 启动**（`[own-3b-07]`）。备选：三者独立；或每个实例都跑独立的投递循环（吞吐随实例数增长，钉钉侧并发也随之增长）。缺省：本件形状。
10. **R01 的门行**（门号已于 2026-10-07 随 R01 裁定，修订 3 收窄本题）：M4-a→门 23、M4-b→门 24、M4-d→门 25、M4-c→门 8 子集。仍待点名的只有落锁：这些新行由只改锁的 Draft PR #6248 写进 `arm-set`（自检改 `range(1,27)`），它的合并另需点名；在那之前本 PR 的格按候选、未计分交付。
11. ~~R17 若不采纳~~ **已裁（2026-10-07）**：R17 落槌（写入时与发送时都校验在职），这一问不再成立（§4.6）。
12. **基分支**：与 PR-3a §12-Q5 同一个问题；本件缺省以 PR-3a 分支（`claude/tasks-m4-pr3a`，Draft #6266）为基，以非 main 为基时哪些 lane 不触发见 §9.6。
13. **钉钉集成所在的 org**（`[own-3b-13]`，§5.1）：新建的钉钉集成落在 `'default'` org 下，而本件按任务所在 org 找集成且不回退，所以 org 不是 `'default'` 的任务不会产生通知。备选：另设计一种 org 与集成的对应关系（新设计，不在本 PR）。缺省：失败即关闭，PR body 写明。
14. **改任务 B 的 `task-access.ts`**（`[own-3b-17]`）：私有 org 生成器改为带参数、新增 `buildTaskByIdAnyStateCondition`，只供 `deleted` 事件族读软删行；门 1 的 needle 与既有快照不变。R04（已裁）只覆盖 `buildTaskByIdCondition`，本题的新构造器不在其内，仍待答。缺省：做。不同意 ⇒ `deleted` 事件族不通知（记为对 D13 的偏离）。
15. **集成停用时的行为**（`[own-3b-18]`）：只有非活跃集成时记 `skipped/dingtalk_org_integration_inactive`（D4 的推荐值）。备选：按可重试处理，集成在约 81 分钟内恢复即自愈，之后 `failed`（考勤 H1 的做法）。缺省：skipped。
16. **正文的逐行标签**（`[own-3b-20]`）：`编号 <outbox 行 id 前 8 位>`。备选：事件时刻（需要一个不新增 Intl 调用点的格式化方式）或其他产品文案。缺省：编号。
17. **（给 PR-3a 的可选建议）claim 用的部分索引** `(next_attempt_at, created_at) WHERE status IN ('pending','retrying')`：PR-3a 的迁移尚未应用，加在那里没有迁移成本；P1 规模下不是前提。缺省：不加，PR-3a 自行决定（修订 5 复核：PR-3a 的 Draft #6266 没有加，claim 的执行计划仍如 §7.2 所述）。
18. **出站地址白名单**（`[own-3b-21]`）：只接受 `https` 的钉钉域名。经代理或自建网关的部署需要一个额外的放行名单（新的 env 旋钮，要进 manifest）。缺省：严格白名单。
19. **manifest 规则**（`[own-3b-22]`）：三条目要不要带 `requires` 规则（会在运维状态工具里新增停止条件，并要同片改钉死 rule id 集合的测试）。缺省：不带。
20. **发送配置只取集成行**（`[own-3b-19]`）：只在 env 里配置工作通知应用、集成行没有 `workNotificationAgentId` 的部署，任务通知会以 `dingtalk_config_unavailable` 结束，需要管理员在集成上补齐配置后才会发送。备选：无（本通道的配置来源只有集成行）。缺省：只取集成行，PR body 写明。
21. ~~R01、R04、R13 在本 PR 里是否按已裁处理~~ **已答（2026-10-08 转达 2026-10-07 的裁决）**：三条都已裁（回复模板对 R02–R23 的批准含 R04、R13，模板末句含 R01）。修订 3 改标 `RULED(2026-10-07)`，R13 的措辞改为它裁定的内容；取值不变。
22. **加人致重启时，新加的负责人是否收到「已重启」通知**（修订 2 新增，S3）：N1 与 D13 合起来的结果是：`all` 模式给已完成的任务加人，任务重启，事件收件人按写后集合，新加的人作为负责人收到这条通知；它在效果上接近 R05-opt 所说的情形（未采纳），但触发它的是重启事件而不是加人本身，没有重启的加人不发任何通知。备选：收件人按写前集合（新加的人不收，删人致完成时被删的人收）。缺省：写后集合（§4.3 的原文），S3 有格钉住两种人的去向。
23. **自管重启让已完成的 `all` 任务翻回 open 时是否通知**（修订 4 新增）：`reopenTask` 以 scope `'self'` 清掉操作者自己的完成行、使一个已完成的 `all` 模式任务翻回 open 时，写入的事件是 `self_reopened`；按已裁的触发闭集（[R05] [D13]）它不通知，于是之前收到「已完成」的收件人（创建人 / 其他负责人 / 关注人 / 清单成员）没有人收到「已重启」。代码按裁定实现，不是偏离；与之对照，`applyComplete` 在翻转时记 `completed`（被通知），N1 也是为同类翻转补的通知。备选：翻转时记 `reopened`（actor 为操作者），与完成一侧对称——这改任务 B 的语义，需裁。缺省：不改；`task-m4-outbox` 钉住的是非翻转的 `self_reopened` 零行，翻转一例待裁后再加格。
24. **R06「到点时已完成不提醒」的读法**（修订 4 新增）：本件在发送时复核任务与负责人状态（§6.2、§7.4）。于是：任务在 `remind_at` 之前完成、又在 W 之内重启，下一个扫描写出提醒行、worker 发送（最多迟 W）；`all` 模式里某负责人在时刻之前完成自己那一行、在 W 之内撤销，同样迟到收到提醒。两种读法：按处理时刻的状态（本件）或按 `remind_at` 那一刻的状态。影响有界：每个（任务、`remind_at`、收件人）至多一条迟到的提醒，且只在任务开放时发出。缺省：按处理时刻。若取另一读法：按时刻之前的完成 / 重启事件判定，或在时刻为已完成的任务 / 负责人写一条 `skipped` 行占住 source key，之后的重启不再发。

---

## 14. 实现切片

顺序执行。每片结束时 `pnpm --filter @metasheet/core-backend type-check`、`test:unit`、`tasks-realdb` 清单里的全部文件（本地一次性库，`EXPECT_DB=1`、`TASKS_ENABLED=true`）都要绿；动到 `scripts/ops/` 的片另跑 `node --test`。每片一个代理。路径省略前缀 `packages/core-backend/`；「登记三处」同 PR-3a §13。生产码 mutant 只在一次性检出里跑。

### 14.0 入口条件与重叠（修订 1 新增）

- **S0、S1** 只加新文件、manifest 的三个新条目、以及任务 D 的 `task-reminders.ts` / `task-notifications.ts` 两个纯函数模块（PR-3a 的切片计划不碰这两个文件），可以从 PR-3a 在动手那一刻的 HEAD（不早于 `aafa05f2d5`）起。
- **S2 起**（含 S2）只能从一个**已含 PR-3a S5–S9 提交**的 PR-3a head 起（owner 去掉 PR-3a S9 时，为「含 S5–S8」）。理由逐条：S2 的归档触点与 `buildTaskListsOfTaskCondition` 需要 S5 的 `task-list-records.ts` 与 `task-list-access.ts`；S4 的在职复核需要 S6 的 `task-org-members.ts`；S2 改的 `task-records.ts`、`task-structure.ts` 的 handler 与 S3 改的 `tests/integration/task-m3-membership.db.test.ts`，PR-3a 的 S7 / S9 也改（S9 另改七份既有真库文件）。在更早的 head 上做 S2 之后的片，要么编译不过，要么在重叠时与同一段代码冲突。
- **两次重叠**：S2 动手前，把 S0–S1 重叠到满足上一条的 PR-3a head；S7 动手前，再重叠到 PR-3a 的最终 head。每次：`git merge-tree --write-tree` 查冲突 → 实际重叠 → type-check、`test:unit`、`tasks-realdb` 全部文件、manifest 测试重跑 → 用到的 PR-3a SHA 与结果按片记进验证 MD。S2 入口时同时重核本文按名字引用的 PR-3a 符号与行号（§0 基座一条）。
- **PR-3a 在 S9 之前停住时**：PR-3b 停在 S1，不提前做 S2 及之后的片；验证 MD 记明在等哪一片。这是排期，不需要 owner 裁决。

### S0 基座与 flag（依赖：无；入口见 §14.0）

- 从 PR-3a **当时的** HEAD 起新分支；SHA 记进验证 MD。
- 文件：`src/services/task-notification-flags.ts`（新，三个读函数 + 派生谓词 + 通道名列表 + interval 解析）；`scripts/ops/global-history-flag-manifest.mjs`（三条目，只写 `dependsOn`，不设 `rules`，§9.2）；`tests/unit/task-notification-flags.test.ts`（新）。
- 测试：manifest 测试绿（三个 token 有读点、有条目；rule id 集合断言不受影响，测试文件不改）；删一条目 ⇒ 红（记进验证 MD）；`approval-feature-payload-flag-ledger.test.ts` 在 rebase 后的 main 上绿。文件数 3。

### S1 纯函数（依赖：S0）

- 文件：`src/tasks/task-reminders.ts`（追加：带键集游标的扫描条件、页大小常量、汇总到点判定）、`src/tasks/task-notifications.ts`（追加）、`src/tasks/task-notification-text.ts`（新，含逐行标签）、`src/tasks/task-delivery-protocol.ts`（新：常量、带 `fenced` 的分类、`orderClaimedDeliveries`、事件新鲜度、出站地址判定）；`tests/unit/task-reminders.test.ts`（追加）、`tests/unit/task-notifications.test.ts`（追加）、`tests/unit/task-notification-text.test.ts`（新）、`tests/unit/task-delivery-protocol.test.ts`（新）。
- 测试：§11.8 中这四个模块的部分；门 20 harness 对新导出全绿；hourcycle 守卫绿。文件数 8。

### S2 producer 与触点（依赖：S1；入口：PR-3a head 含 S5–S9，§14.0）

- 文件：`src/services/task-notification-producer.ts`（新，含 `resolveTaskDeliveryChannelsForOrg`）；`src/tasks/task-list-access.ts`（追加 `buildTaskListsOfTaskCondition`）；`src/services/task-records.ts`（`writeEvents` 返回值；complete / reopen 挂钩）；`src/services/task-structure.ts`（`writeMembershipEvents` 返回值；五个触点）；`src/services/task-list-records.ts`（归档触点）；`tests/unit/task-list-access.test.ts`（追加）；`tests/helpers/task-m4-fixtures.ts`（追加 `seedOutboxRow`、在任务所在 org 播种集成行的 helper）；`tests/integration/task-m4-outbox.db.test.ts`（新，登记三处）。
- 测试：§11.2（空汇总形状格除外，它在 S4）、§11.3（除 N1 两格）；flag 全 OFF 时 M2/M3/PR-3a 既有真库文件原样绿。文件数 8 + 三处登记。

### S3 N1（依赖：S2；N1 已于 2026-10-07 落槌，本片必做）

- 文件：`src/tasks/task-membership.ts`；`tests/unit/task-membership.test.ts`；`tests/integration/task-m3-membership.db.test.ts`（既有断言按新增事件更新）；`tests/integration/task-m4-outbox.db.test.ts`（N1 两格）。
- 测试：§11.3 的 N1 两格；M3 既有格更新后全绿。文件数 4。

### S4 worker（依赖：S2）

- 文件：`src/services/task-notification-delivery-worker.ts`（新；含各族物化与 skip 规则、清扫、claim、栅栏续租、退还、终态、`runUntilIdle`）；`src/tasks/task-access.ts`（`taskOrgClauseWith` + `buildTaskByIdAnyStateCondition`，需 owner 确认，§13-Q14）；`tests/unit/task-access.test.ts`（追加）；`src/metrics/metrics.ts`（结果 counter）；`tests/helpers/task-m4-fixtures.ts`（带 spy 的 `FakeTaskDeliveryChannel`、`steppedClock`）；`tests/integration/task-m4-delivery.db.test.ts`（新，登记三处）。
- 测试：§11.6 的 worker 部分（交错、慢通道、优先级、新鲜度、停机、第二租户、毒行、退避）、§11.4 的 worker 格、§11.5 的 worker 格（含空汇总形状格与「当天后到」格）、§11.9 中对应的变异（含门 1 单点 org mutant 下的第二租户格）。文件数 6 + 三处登记。

### S5 调度器与启动接线（依赖：S4）

- 文件：`src/services/task-scheduler.ts`（新；专用 leader 客户端与 `error` 监听、扫描分页、锁外投递循环）；`src/index.ts`（`startOnce` 一段、`stopOnce` 一段）；`src/metrics/metrics.ts`（leader gauge、积压 gauge）；`scripts/ops/global-history-flag-manifest.mjs`（`TASKS_ENABLED` 的 `purpose` 追加一句，§9.2）；`tests/integration/task-m4-scheduler.db.test.ts`（新，登记三处）。
- 测试：§11.4 的扫描格（含跨页两格）、§11.5 的 tick 格与对拍、§11.6 的取锁格（计数 job）、leader 连接被终止格与各自负控、全 OFF、`stop()`（8 秒上限）；manifest 测试仍绿；门 13 类测试（只构造不 `start()`）不受影响。文件数 5 + 三处登记。

### S6 钉钉通道（依赖：S4）

- 文件：`src/services/task-notification-dingtalk.ts`（新；配置只取集成行、出站地址判定、token 与发送的超时选项、token 后复核、栅栏后分类）；`src/services/task-notification-delivery-worker.ts`（`createTaskDeliveryChannelsFromEnv` 接真通道）；`tests/helpers/task-m4-fixtures.ts`（`seedDirectoryBinding`，含集成配置）；`tests/integration/task-m4-dingtalk.db.test.ts`（新，登记三处）。
- 测试：§11.7 全部；身份 join 的 org 合取、通道配置来源、栅栏后「其余可重试」三个变异。文件数 4 + 三处登记。

### S7 收口（依赖：S3、S5、S6；S3 去掉时依赖 S5、S6）

- 先按 §14.0 重叠到 PR-3a 的最终 head 并全量重跑。
- 文件：验证 MD（新：各次重叠用到的 PR-3a SHA、各文件收集数与展开数、本地跑的 lane、变异记录、rebase 后 payload 台账守卫结果、S2 入口时重核的 PR-3a 符号）；PR body；本设计入库（只保留条目 id）。
- PR body 必须写到：无 DDL 与对 PR-3a 迁移的依赖；三个 flag 默认 OFF、staging runner 无输入、prod 只经手动 dispatch；投递保证的精确表述与 `outcome_unknown` 的人工核对；`sent` 的定义与已知的静默未达路径（§8.3）；关闭语义的两半（关闭期间的新事件不补发、已写下的行按新鲜度处理）；容量陈述与没有按 org 的公平调度（§6.4）；只为有活跃钉钉集成的 org 写行、以及集成落在 `'default'` org 时其他 org 的任务不会有通知（§5.1）；发送配置只取集成行、只在 env 配置应用的部署需要补齐集成配置（§8.2）；出站地址白名单（§8.5）；leader 会话由 leader 事务自己设的 `idle_in_transaction_session_timeout` 界限与扫描的心跳限住（§6.1；修订 4 起是实现的行为，不再是给运维的建议）；无序到达；M4 不做硬删、账本行一直保留（R13）；R01 的新门行未入锁（候选、未计分）；N1 是否随本 PR；哪些 lane 未触发、本地结果在哪；不点名任何未修的安全残留。修订 5 另加：`last_error` 的脱敏作为规则陈述（栅栏前只有固定码，§8.5）、注册只看开关（§8.1）、真库 lane 现为 20 个文件、与 PR-3c 的重叠与解决次序。
- 执行记录：验证 MD 的「S7 收口」与「总览（S0–S7）」两节。PR body 与 squash 提交说明的草稿不入库。

**修订后对切片计划的复核**：每一条新格都落在它所依赖的代码首次出现的那一片（跨页格与 leader 连接格在 S5，交错 / 慢通道 / 优先级 / 新鲜度 / 第二租户 / 空汇总形状格在 S4，配置、出站地址与分类格在 S6，org 前提与他 org 清单格在 S2）；§11.1 的文件表与本节的文件清单一一对应；对 PR-3a 模块的两处追加（`task-list-access.ts` 在 S2、`task-access.ts` 在 S4）都在 §14.0 的入口条件之后；S3 被去掉时 S7 直接依赖 S5、S6，其余依赖不变。

---

## 15. 风险

1. **`lock_timeout` 对咨询锁等待是否生效**是本件 leader 设计的前提；S5 第一格就实证它。若不生效，退路是 `SET LOCAL statement_timeout` 同样取消等待（`57014` 已按同一分支处理），语义不变。
2. **leader 连接的后端被终止**（`idle_in_transaction_session_timeout`、`pg_terminate_backend`、切换、断网）：专用客户端上的 `error` 监听让进程存活、本 tick 放弃（§6.1）；锁已提前释放，另一实例可能开始扫描，两边的扫描以唯一键幂等，只多做工。没有这个监听时，同样的事件会让主进程以未处理的 `error` 退出——所以 §11.6 有一格专门钉住它。半开的 leader（主机消失、网络分区）由 leader 事务自己设的 30 s 空闲界限结束（修订 4，§6.1）；活着的 leader 靠扫描的心跳留在界内——一页扫描若慢于 30 s（数据库停顿），leader 会被结束、本 tick 放弃、下一个 tick 重来，这是接受的退路。
3. **`outcome_unknown` 积累**：没有重投接口，全靠人工；首次上线的钉钉网络抖动会直接体现为这类行。
4. **关闭语义分两半**：投递线关着期间发生的事件永久不通知；关之前已经写下的行是暂停，重新打开后按发送时的新鲜度发或跳过（事件族与清单族 24 小时、提醒 W、汇总当天窗口，§5.1、§7.4）。运维要同时知道这两半。
5. **PR-3a 漂移**：归档触点、`task-list-access.ts`、`task-org-members.ts`、`writeEvents` 的形状都以 PR-3a 的实际提交为准；§14.0 的入口条件与两次重叠负责这件事，S2 入口时重核名字与行号（修订 2 已在 `d940fa8745` 上重核）。
6. **N1 改任务 C 模块**：已裁（2026-10-07）；M3 既有断言随之更新，属于改已合并测试的钉死值（只加断言，不改既有取值）。
7. **汇总在发送时算**：worker 迟到超过 W 的那天没有汇总；与 R07 字面的「tick 侧记 skipped」有偏差（§13-Q5）。
8. **吞吐与钉钉配额**：吞吐由每行发送耗时决定（§6.4 的容量陈述），与钉钉侧的应用配额、每员工每日上限的关系没有实测；没有按 org 的公平调度，一个 org 的大扇出会让别的 org 的事件通知排队（提醒与汇总优先，不受影响）。
9. **账本无限增长**（`[R13]`）：每次完成 / 评论最多上千行，无清理；P1 规模可接受，超过时需要另开保留期切片。
10. **无序到达**与**每 org 一份汇总**是产品面可见的行为，前端 / 文案要提前知道。
11. **转义是启发式**：钉钉 markdown 方言没有公开的完整语法，转义集合可能漏项；测试只覆盖链接、标题、代码块三类。
12. **首次打开开关**：最近 2 小时到点的提醒与窗内的汇总会发出，更早的不发；事件族与清单族在关闭期间本来就不写行，若有更早一次打开时留下的行，只发行龄在 24 小时以内的。要写进上线 checklist。
13. **`sent` 不等于看到**：`asyncsend_v2` 受理即记 `sent`；评审者引用的平台规则（同内容一日一次、每员工每日条数上限）与可见范围都会造成静默未达（§8.3）。逐行标签只针对第一条。
14. **org 与集成的对应**：新建的钉钉集成落在 `'default'` org 下，其他 org 的任务在这种部署里不会产生通知（§5.1、§13-Q13）。这是失败即关闭，但用户会看到「开了却没有通知」。
15. **发送配置只取集成行**：只在 env 配置工作通知应用的部署，任务通知会以 `dingtalk_config_unavailable` 结束，直到管理员在集成上补齐配置（§8.2、§13-Q20）。

---

## 设计自查（评审时最先攻击的点）

1. **把 `sending` 当效果栅栏、claim 不改 status**——与考勤 worker 的列语义不同，同名列在两条线上含义不同，运维看账本时会混淆；触发器级的状态机保护也没有。反驳者会问：为什么不加一列（e-learning 做了）？答案是「不开 DDL」，但这是取舍不是定理。
2. **`lock_timeout` 对 `pg_advisory_xact_lock` 生效**——本件把它写成测试格而不是引用文档；若某个 PG 版本行为不同，整个 M4-d 的期望要重写。
3. **关闭期间不写行、已写的行按新鲜度处理**（§5.1、§7.4）——推理链靠 R06 的类比与 R13 的无清理；owner 完全可能更想要「总是写、恢复后补发」。这一条一翻，producer 的开关判断与 §7.4 的 24 小时新鲜度都要改；修订 1 之前本文把「关」一律写成丢弃，对已写下的行是错的（评审指出，已更正）。
4. **`task-access.ts` 的带参数生成器**——修订 1 把 worker 原先自写的四处 org 子句收回单点构造器（门 1 的单点 mutant 因此覆盖到 worker），代价是又改了一次任务 B 的模块（需 owner 确认，§13-Q14）；owner 不同意时 `deleted` 事件族不通知。反驳者会问：为什么不只让 `deleted` 族读活行、干脆不发？答案是 D13 把 `deleted` 列在触发闭集里，先按推荐值做、把退路写明。
5. **汇总内容在发送时算**——把 R07 的「tick 侧记 skipped」改成 worker 侧，且 worker 迟到即当天无汇总；这两点都偏离字面。
6. **DB 锚定时钟**（§6.5）——多了一个概念；单实例下纯属多余，多实例下的收益没有量化。
7. **N1 放在本件**——改任务 C 的纯函数与 M3 的钉死断言，和「M4 只消费事件不改语义」的自述打架；N1 已在 2026-10-07 落槌，这一条从「待裁」变成「已裁的语义变更」，S3 只在状态真的翻转时追加事件。
8. **转义集合**与**不带链接**——安全上保守，产品上寒酸；若 owner 要链接，整段文案与一个新 flag 都要回炉。
9. **在职复核依赖 PR-3a S6**——S2 的入口条件已要求 PR-3a 的 head 含 S5–S9（§14.0），所以不会在缺 helper 的基座上开工；R17 已裁，helper 保留在 PR-3a，修订 1 准备的复制查询不再需要。
10. **测试的「无 sleep」承诺**——并发格靠 deferred 与步进时钟；真库的 `now()` 格靠翻转点等待，后者本质上仍是等待，只是有界。
11. **投递在锁外**（`[own-3b-07]`，修订 1 改）——离开了考勤的「worker 是调度器 job」形状；两个实例的投递循环可能重叠。反驳者会问：那 leader 锁还保护什么？答案：它只让两个扫描不并行，投递的正确性从来就靠 `SKIP LOCKED` 与栅栏 CAS，§11.6 的交错格与两个 mutant 就是为了证明这一点。
12. **逐行标签**（`[own-3b-20]`）——为了对付一条修订 1 没有亲自核对原页的平台规则，给每条通知加了一行对用户没有意义的编号。反驳者会说这是用产品观感换可靠性；备选见 §13-Q16。

---

## 16. 评审处置（修订 1）

三个视角（合规 PR3B-C、并发与可靠性 CONC、安全与运维 SEC / OPS / CI / PLAN / TEST）共 34 条；三个评审者全部返回，没有缺席。每条都对源码核实过：33 条属实并已改正文，1 条（CONC-12）部分采纳；没有整条驳回。「待 owner」= 正文带缺省值交付，缺省值需 owner 确认（给出 §13 题号）。评审者在各自一次性库上的实测按其记录引用；修订 1 自己的实测只在 一个一次性库（已删除）上做过两件事：键集扫描一个 tick 排空 600 个同一时刻的到点任务、以及「20 万行终态 + 200 行到期」时 claim 的执行计划。

| id | 处置 | 位置 |
|---|---|---|
| PR3B-C01 | 已改：提醒扫描在一个 tick 内用 `(remind_at, id)` 键集游标排空窗口；floor 与窗口判定留在 TS；原「留给下一个 tick」的错误陈述删除 | §6.2、§11.4、§11.9、§12 `[own-3b-15]` |
| PR3B-C02 | 已改，取 CI-1 的方案 (b)：三条目不设 `rules`、测试文件不改（因此不需要把测试文件加进 S0） | §9.2、§9.5、§14 S0、§13-Q19 |
| PR3B-C03 | 已改：交错格用批大小 5 与两个 deferred 固定顺序，claimant 从 spy 读；两个 mutant 各自的红法；取锁格加计数 job | §11.6、§11.9 |
| PR3B-C04 | 已改：窗口 mutant 分成 SQL 侧（绑扫描格）与 TS 侧（绑 worker 的 `reminder_window_elapsed` 格）；每个 mutant 写明对应的格 | §11.4、§11.9 |
| PR3B-C05 | 已改（同 CONC-3、OPS-2）：栅栏续租到 `sendLease`、批内没轮到的行退还且次数回退、每行预留时间界；§7.5 的原陈述改写 | §7.1、§7.2、§7.5、§11.6 |
| PR3B-C06 | 已改：worker 的任务 / 清单读改经单点构造器，`deleted` 族用新的 `buildTaskByIdAnyStateCondition`；第二租户格绑门 1 的单点 mutant。改任务 B 模块待 owner（§13-Q14） | §3.4、§7.4、§10、§11.6 |
| PR3B-C07 | 已改（同 PLAN-1）：S2 起的入口条件与两次重叠 | §0、§14.0、§14 S2 / S7 |
| PR3B-C08 | 已改（同 CONC-6、SEC-2）：producer 按 org 的通道前提；身份 0 行三支都按 D4 记 skipped 与各自的固定码，不再有注定失败的重试。集成恢复后自愈的备选待 owner（§13-Q15） | §5.1、§8.2、§12 |
| PR3B-C09 | 已改（同 CONC-8）：事件族与清单族发送时新鲜度；关闭语义分两半写明 | §5.1、§7.4、§15 |
| PR3B-C10 | 已改：逐行顺序改为 prepare → 物化 → 栅栏；token 后复核身份与配置；栅栏后无法归类 ⇒ `outcome_unknown` | §3.3、§7.4、§8.2、§8.4 |
| PR3B-C11 | 已改：M4-a 加空汇总形状格；「当天后到」格钉在 `sendAt + 30 分钟` 并写明 mutant | §11.2、§11.5、§11.9 |
| PR3B-C12 | 已改：`[R13]`、`[D14]` 入表并在 manifest `purpose` 标注 | §9.2、§12 |
| CONC-1 | 已改（同 PR3B-C01）；「把 floor 移进 SQL」一项未采纳：它会遮住 floor 的 TS mutant，而游标已经让 floor 不满足的行不再占名额 | §6.2、§11.9 |
| CONC-2 | 已改（同 SEC-1）：发送配置只取产生身份的那一行集成；部署后果待 owner（§13-Q20） | §8.2、§10、§11.7 |
| CONC-3 | 已改（同 PR3B-C05）；发送与 token 的超时改由任务线常量经 `options.timeoutMs` 传入，env 超时不再影响栅栏 | §7.2、§8.2 |
| CONC-4 | 已改：leader 用专用客户端并全程挂 `error` 监听；§6.1 失效表与 §15-2 改写；加连接被终止格 | §4.2、§6.1、§11.6、§15 |
| CONC-5 | 已改：投递移到锁外并在一个 tick 内连续多批、有窗口的两族优先、写明容量；「每个实例都跑投递」的备选列入 §13-Q9；按 org 公平调度未做（P1 接受，写进 PR body） | §6.4、§7.2、§7.3、§11.6 |
| CONC-6 | 已改（同 PR3B-C08） | §5.1、§8.2 |
| CONC-7 | 已改（同 PR3B-C03） | §11.6 |
| CONC-8 | 已改（同 PR3B-C09） | §5.1、§7.4、§15 |
| CONC-9 | 已改（同 OPS-3）：stop grace 8 秒，小于 10 秒的关停屏障；`stopping` 后不再过栅栏；超时的那一行由清扫记 `outcome_unknown` | §6.6 |
| CONC-10 | 已改：次数用尽的清扫同样置 `redelivery_safe` | §7.2、§11.6 |
| CONC-11 | 已改：清单成员扇出经带清单 org 子句的新构造器，并写明所依赖的 PR-3a 前提 | §5.3、§11.3 |
| CONC-12 | 部分采纳：更正「索引服务 claim」的陈述（claim 的代价与到期积压成正比，不与账本总行数成正比，有执行计划为证）；PR-3b 不做 DDL；部分索引作为给 PR-3a 的可选建议 | §7.2、§13-Q17 |
| SEC-1 | 已改（同 CONC-2）；正文只写本通道的规则与理由 | §8.2、§10、§11.7 |
| SEC-2 | 已改（同 PR3B-C08）：身份 0 行按 D4 记 skipped；写明集成所在 org 的现状与失败即关闭的后果；夹具直接在任务所在 org 播种集成行。org 映射待 owner（§13-Q13），自愈备选待 owner（§13-Q15） | §5.1、§8.2、§11.1 |
| SEC-3 | 已改：写明本通道不经出站守卫；出站地址限 `https` 的钉钉域名，否则不发 token 请求。放宽待 owner（§13-Q18） | §8.2、§8.5、§11.7 |
| OPS-1 | 已改：正文末行逐行唯一的标签；`sent` 的定义与已知的静默未达路径写进 PR body。平台规则按评审者引用记录，修订 1 未自行核对原页；标签形式待 owner（§13-Q16） | §7.1、§8.3、§11.8、§15 |
| OPS-2 | 已改（同 PR3B-C05、CONC-5）；另加积压 gauge | §4.1、§6.4、§7.2 |
| OPS-3 | 已改（同 CONC-9） | §6.6 |
| CI-1 | 已改，取方案 (b)；`TASKS_ENABLED` 的 `purpose` 追加一句放在 S5（PR-3a 的 S5、S8 也改这个条目） | §9.2、§14 S0 / S5 |
| PLAN-1 | 已改（同 PR3B-C07） | §14.0 |
| TEST-1 | 已改（同 PR3B-C03） | §11.6 |
| TEST-2 | 已改：`task-m4-delivery` 与 `task-m4-scheduler` 每格前清空账本表（lane 串行执行文件），断言只看本格的行 id | §11.1 |

修订后对切片计划的复核见 §14 末尾。
