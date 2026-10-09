# 任务功能线 — 总体设计与验证（2026-10-09）

- 日期：2026-10-09。状态：**汇总记录**。本文只汇总已在 `main` 或已在 Draft 分支上的设计与验证记录，不构成合并授权、DDL 应用授权或任何 `TASKS_*` 开关的授权，也不改动锁（`docs/development/task-feature-design-lock-20260917.md`）的任何条款。
- 基线：`origin/main` @ `64bf18b5e8`（#6250，2026-10-09 取）。各 Draft 分支的 head 记在 §1.3 与 §8。本文日期一律按 UTC+8。
- 对标：飞书「任务」。范围按锁 §0–§3 的裁决，见 §1。
- 引用口径：锁与各里程碑的设计 / 验证记录按仓库路径引用；只在 Draft 分支上的文档以 `分支名:路径` 引用；PR 以编号引用；owner 裁决只写条目编号与日期。裁决包与裁决书不在仓库内，本文不转述其原文。
- 本文是 2026-10-01 开发目标里总体设计与验证 MD 一项的交付；每个 PR 自己的设计与验证记录仍以各分支内的文件为准，本文不代替它们。

---

## 0. 结论摘要

1. **已落 `main`**：M0 普查与锁（#5845）、M1 裁决（2026-09-26）、任务 B 纯函数（#6086、#6102）、M2 后端（#6062）与前端（#6092）、任务 C 纯函数（#6123）、前端门禁 R-28（#6173）、staging runner 三件（#6158、#6167、#6177）、M3 后端（#6229）与前端（#6159）。锁正文 §0–§11、§13–§15 于 2026-09-26 ratify，§12 门表于 2026-09-28 ratify（PR #5845 评论 5871552862）。
2. **staging**：运行 `main` `7137688372` 的镜像，`TASKS_ENABLED=true`，M2 与 M3 的迁移已应用（含 `task_comments`）；生产未动；三个 P1 开关在任何环境都未打开。
3. **Draft，未合并**：任务 D（#6186）、锁 R01 增补（#6248）、M4 PR-3a（#6266）、M4 PR-3b（#6281，以 #6266 为基）、M4 PR-3c（#6269，叠在 #6266 上）、M4 前端（#6265）、任务 E（#6249）。#6126（M3 HTTP 契约文档）仍是开着的 Draft，实现已由 #6229 落 `main`，处置待 owner 点名（§6.1）。M4 起每一阶段的合并都要 owner 另行点名；推荐的合并序是 #6248 → #6266 → #6281 → #6269 → #6265（§6）。
4. **未开始**：M5 的路由 PR-4a / 4b / 4c 与前端 FE-d / e / f，按 2026-10-09 的裁决在 M4 合并授权之后才起 Draft。
5. **验证面**：每个 PR 都有独立多视角闸审（每条发现三票反驳）、单测、真库 lane（本地 PostgreSQL 15.17；PR-3b 与 PR-3c 闸修复后的 lane 另在另一台机器的 PostgreSQL 16.15 上跑过，PR-3a 自己的记录把 postgres:16 记为 NOT RUN，见 §5）、专属鉴权门、源码变异证明；M3 后端另有合并前对 `main` 的合并预演与 staging 部署 + 冒烟。未跑的项目逐条列在 §5。

---

## 1. 范围与对标

### 1.1 对标结论（锁 §0、§2、§3）

飞书「任务」分三层：任务实体、任务清单、IM 原生层。本线对标**实体层**全部承重机制，清单层按 P1 / P2 分期做实体与投影，IM 原生层不对标。承重机制（锁 §2）：四种角色视角 + 已完成 + 全部；多负责人与全部 / 任一完成；创建人完成的范围与重启的 `scope`；子任务含根五层；创建人默认为负责人且可移除、零负责人合法；截止日期与具体时间点、提醒缺省 −30 分钟 / 当天 18:00；红点三种口径；关注人只读 + 评论 + 退出；清单归档不改变任务可见性；可见不等于等我处理。

| 模块 | 裁决 | 期次 | 状态 |
|---|---|---|---|
| 任务实体 / org / 五视角 / 完成重启 / pending / 前端 `/tasks` `/tasks/:id` / 红点 / 缺组织引导 | 做 | P0-A / M2 | 已合并 |
| 子任务树 / 评论 / 成员 / 完成模式 / 软删 | 做 | P0-B / M3 | 已合并 |
| 清单 / 分组 / 设置 / 日期写入与 PATCH / 分页 / 提醒 outbox / 事件通知 / 调度 / 钉钉通道 / 红点实时失效 | 做 | P1 / M4 | Draft |
| 重复任务 / 附件 / 里程碑与依赖 / 投影 + 交互 / 自定义字段 / 清单导出 | 做 | P2 / M5 | 纯函数 Draft；路由未开始 |
| IM 原生（消息转任务、会话列表、文档内嵌、独立窗口、小组件、外部联系人、飞书项目） | 不做 | — | — |
| 清单「申请权限 → 所有者同意」 | 不做（直接分享） | — | — |
| 站内通用收件箱 | 不做（待办中心线） | — | — |
| 甘特关键路径/整条拖动/着色/联动 | 不做（多维表线） | — | — |
| 新表 DML 普查闸 | 不建（M2–M5 均如实声明任务表不在普查分母） | — | R21（M4）、S37（M5） |

M4 / M5 的裁决另排除：清单删除与任何硬删作业（R13）；`tasks:admin` 的任何旁路或消费路由（R18）；清单动态推送到群（R19）；接入待办中心 registry（R22）；富文本（S29）；cursor 分页（S34）。

### 1.2 对标的证据口径

飞书离线语料 26 篇的行号口径以普查 `docs/development/task-feature-census-20260917.md` 的脚本为准（去 script/style、按块元素拆行、去空行后的绝对行号）。M4 前端与 M5 的设计发现另一份手头文本是审批手册、不含任务页面，凡只能由它取证的交互一律标 UNVERIFIED，不归因于飞书。

### 1.3 里程碑图

| 里程碑 | 内容 | PR / 分支 | 状态 | 合并提交 / head |
|---|---|---|---|---|
| M0 | 普查 + 锁（PROPOSED → RATIFIED） | #5845 | 已合并 2026-09-28 | `601990756f` |
| M1 | owner 裁决四题 + 拆分 + 起任务 B | PR #5845 评论 5835498504 | 已裁 2026-09-26 | — |
| 任务 B | 无 I/O 纯函数（锁键、id、日期、角色 / 视角、完成判定） | #6086 | 已合并 2026-09-27 | `1a3e83a33a` |
| — | 零负责人任务的完成 / 重启幂等（`wasDone`） | #6102 | 已合并 2026-09-27 | `6adc99fd0e` |
| M2 后端 | P0-A 四表、权限码 seed、八条路由、结构锁 | #6062 | 已合并 2026-09-28 | `0d1da49291` |
| M2 前端 | `/tasks`、`/tasks/:id`、导航入口、红点、引导 | #6092 | 已合并 2026-09-28 | `5e8f643a58` |
| 任务 C | 无 I/O 纯函数（子任务树 / 成员 / 评论 / 软删） | #6123 | 已合并 2026-09-28 | `bbb92dab7f` |
| staging runner | `tasks_enabled` 输入 + 非管理员冒烟；迁移演练兼容；owner 排除清单 | #6158 / #6167 / #6177 | 已合并 2026-09-29 / 09-29 / 09-30 | `f47054d88e` / `b35d4cd1fb` / `04de335490` |
| 前端门禁 | R-28：入口、红点与请求受会话 feature `tasks` 门控 | #6173 | 已合并 2026-10-01 | `0386f47fdc` |
| M3 契约 | M3 后端 HTTP 契约（文档；实现另开 PR） | #6126 | Draft，仍开着；实现已由 #6229 落 `main`，契约正文以 `main` 的 M3 后端设计为准；处置待 owner 点名（§6.1） | `c117ab06ca` |
| M3 后端 | P0-B：子任务树、成员增删、完成模式、评论、软删 | #6229 | 已合并 2026-10-07 | `57621d2403` |
| M3 前端 | 子任务、成员、完成模式、评论、删除 | #6159 | 已合并 2026-10-07 | `cc6ca96ac2` |
| 任务 D | 无 I/O 纯函数（清单、分组、提醒、通知、设置、分页、实时） | #6186 | Draft | `630e85ead8` |
| 锁 R01 增补 | §11 M4 行拆写、§12 门 23–26 与 `arm-set` 子集行 | #6248 | Draft | `69a7c08f8f` |
| M4 PR-3a | 一条迁移（8 张 P1 表 + `tasks.remind_at`）、清单 / 成员 / 清单项 / 分组 / 设置路由、日期写入与 PATCH、分页、R04、R17 / N2 | #6266 | Draft | `68e40323bd` |
| M4 PR-3b | outbox producer、调度器、投递 worker、钉钉通道、N1、三个开关 | #6281（Draft，base `claude/tasks-m4-pr3a`） | S0–S7 与 S7 之后的再门审修复（S-gate2）完成 | `2974ba5363`（单提交，父提交为 #6266 的 `68e40323bd`；绿线 head `4837f1ffdd`） |
| M4 PR-3c | 红点实时失效（socket 扇出） | #6269（base = PR-3a 分支） | Draft | `3edd133ae0` |
| M4 前端 | 设置页、详情编辑、清单、成员、分组板、i18n、实时订阅 | #6265 | Draft | `5e73a6b8f3` |
| 任务 E | 无 I/O 纯函数（民用日期 / 依赖 / 里程碑 / 重复 / 字段 / 附件 / 投影 / 导出） | #6249 | Draft | `d6c84264ff` |
| M5 路由与前端 | PR-4a 实体扩展、PR-4b 附件、PR-4c 投影；FE-d / e / f | — | 未开始 | — |
| staging 冒烟 | 冒烟脚本随 runner 打包、补 M3 用例 | #6278 | 正常 PR，待必需检查 | `c980f78015` |

---

## 2. 架构

### 2.1 分层（锁 §1）

- **SoR**：PostgreSQL 任务域专用表（§2.2）。任务是实体；待办是投影；任务系统只是待办中心的一个来源，两线在 `PendingItem` 接口交汇。
- **纯函数边界**：`packages/core-backend/src/tasks/` 只放无 I/O 纯函数（含 `task-lock-keys.ts` 只生成键），由门 20 的 harness（`tests/unit/task-pure-no-io.test.ts`）自动发现并校验。数据库访问在 `src/services/task-*.ts`，路由在 `src/routes/tasks*.ts`，三把任务锁的取锁只在 `src/db/task-advisory-locks.ts`（门 7：任务域源码里 `pg_advisory_xact_lock(hashtext(` 字面量恰三处）。
- **不进 DI**：router 工厂 `tasksRouter()` 只在 `process.env.TASKS_ENABLED === 'true'` 时返回路由器；挂载点在审批路由之后，静态子路径排在 `/:id` 前面。
- **投影（P2）**：单向只读到多维表；交互编辑经任务 API 再 reconcile；不把任务做成多维表的一种 sheet 类型。
- **谓词一份真相**：`task-access.ts` 的 `taskMatchesView`（TS）与 `buildTaskScopeCondition`（SQL）是同一套语义的两份文本，靠门 19 的 49 格网格对拍；`buildTaskPendingCondition` 只由 `view:'assigned'` 派生。

### 2.2 数据模型（按里程碑）

| 期次 | 迁移 | 表与要点 |
|---|---|---|
| P0-A（M2，#6062） | `zzzz20260926120000_create_task_p0a_tables.ts`、`zzzz20260926120100_add_task_permissions.ts` | `tasks`（org、标题、`status` open/done、`completion_mode` all/any、日期四列 + `time_zone` + 派生 `due_at`、`parent_id`、`depth` 0..4、`created_by`、`version`、软删）；`task_assignees`（PK `(task_id, user_id)`，零负责人合法）；`task_followers`；`task_events`（`event_type` 闭集 CHECK 一次写全，`payload jsonb`）。权限码 `tasks:read` / `tasks:write` / `tasks:admin` 只 seed `permissions`，不绑角色 |
| P0-B（M3，#6229） | `zzzz20260930090000_create_task_comments.ts` | `task_comments`（`tcmt_` id 四合取 CHECK；`author_id` 可打印 CHECK；墓碑 CHECK：`deleted_at` 与 `body` 互斥非空；`idx_tcmt_task_time`；无 `org_id`，随任务走） |
| P1（M4，PR-3a #6266） | `zzzz20261008090000_create_task_m4_tables.ts`（一个文件；头注写明 Draft 迁移、不从本 PR 应用） | `task_lists`（自带 `org_id`，单点发射）、`task_list_members`（复合主键；`owner` 唯一；`created_by` 永为成员）、`task_list_items`（复合主键；`org_id` 列与两条组合外键，任务与清单必须同 org）、`task_groups` / `task_group_items`（scope `list` / `user`；每 scope 恰一个默认组）、`task_list_events`（15 词闭集）、`task_user_settings`（PK `(user_id, org_id)`；`badge_scope` 三值、`daily_reminder_enabled`、`default_remind_policy` jsonb、`time_zone` 与 CHECK「开每日提醒必须有时区」）、`task_notification_deliveries`（outbox：`org_id` 非空无默认值；`status` 七值含 `outcome_unknown`；`recipient_role` 四值；唯一键 `(org_id, source_key)` 与三条非唯一索引）；`tasks.remind_at` 与部分索引；`idx_tski_task` |
| P2（M5，待 PR-4a / 4b / 4c） | 待建（随 M5 路由 PR 的迁移，归属以三者的设计为准） | `task_dependencies`、`task_attachments` + `task_attachment_purge_intents` + 行删除触发器、`task_fields` / `task_list_field_bindings` / `task_field_values`、`task_record_projection`（PK `(list_id, task_id)`，无 FK）；`tasks` 加 `is_milestone` / `recurrence` / `recurrence_series_id` / `previous_occurrence_id` |

通用约束（锁 §4）：

- **org 归属**：`tasks.org_id` 只取 `req.authenticatedTenantId`；写路径缺 org 一律 422 `ORG_MISSING`（在 `rbacGuard` 之后的 handler 内），不回退、不写默认 org；读路径缺 org 返回空列表 + `degraded: true, reason: 'org_missing'`，单对象读 404。`tasks.org_id = :org` 子句只在 `task-access.ts` 的一处私有生成器里出现（五视角、pending、按 id、按清单四条路径共用）；`task_lists.org_id`、`task_groups.org_id` 各自同样单点。`task_comments` / `task_events` 不设 org 列。
- **id**：任务域生成 id `tsk_` / `tlst_` / `tcmt_` / `tev_`（M4 加 `tgrp_` / `tlev_`；M5 计划 `tfld_` / `tatt_`；outbox 行用 uuid），列上四合取 CHECK（可打印 ASCII、无 `__`、不以 `_` 开头或结尾）；用户文本（标题、名字）走 NFC 归一并剔除空白与零宽字符，空则 422。路径里的 id 若含不可打印字符，在发 SQL 之前按 404 处理；成员 id 还要求不是 `.` / `..`、长度 ≤ 255。
- **日期与时区**（锁 §4.4）：`due_at` 一律在服务层用 `computeDueAt` 重算（全天 = 任务时区当天 23:59:59.999）；逾期 / 今天的三条规则按查看者时区（请求头 `x-viewer-time-zone`，非法或缺失回退任务时区）；写入非法 IANA 时区 422；写入时只落规范名。

### 2.3 纯函数层（任务 B / C / D / E）

| 任务 | PR | 模块（`src/tasks/`） | 内容 |
|---|---|---|---|
| B（M2） | #6086、#6102 | `task-lock-keys`、`task-ids`、`task-dates`、`task-access`、`task-completion` | 三把锁键；id 生成 / 校验、投影记录 id 往返、`normalizeUserText`；`computeDueAt`、查看者时区校验、逾期三规则；角色 / 能力真相表、五视角谓词与 SQL 臂、pending 派生；完成判定与 any / all 的完成 / 重启（`wasDone` 来自加锁后的行） |
| C（M3） | #6123 | `task-tree`、`task-membership`、`task-comments`、`task-deletion` | 深度 0..4、无环、设父 / 转独立 / 父候选；增删负责人 / 切换完成模式 / 增删关注人 / 退出（A1–A7）；评论正文归一与 5000 码点上限、仅作者可改删、墓碑；软删前置判定（有子任务拒绝） |
| D（M4） | #6186 | `task-lists`、`task-groups`、`task-reminders`、`task-notifications`、`task-settings`、`task-pagination`、`task-realtime`；改 `task-ids`（两个前缀）、`task-dates`（一条注释） | 清单角色闭集与动作真相表、成员 / 所有权转换、清单项双事件；分组与整数重排；提醒缺省算法、扫描窗、四族 `source_key`、每日汇总 TS / SQL；收件人网格与优先级；设置闭集与 PATCH 合并；分页 1..100 与稳定排序键；写前写后负责人并集 |
| E（M5） | #6249 | `task-civil-date`、`task-dependencies`、`task-milestone`、`task-recurrence`、`task-fields`、`task-attachments`、`task-projection`、`task-export` | 民用日期；依赖无环（允许菱形）与双端授权；里程碑；重复规则闭集、下一期、派生计划、系列删除；字段六型闭集、config 闭合 schema、三层权限、值可见性；附件白名单与上限、下载判定四道 gate、响应头；投影 id 推导与候选正则、列目录、视图规格、no-op 摘要、能力夹钳；CSV 导出格中和 |
| PR-3a 补 | #6266 | `task-list-access`、`task-edit`；`task-access` 加 `buildTaskByIdCondition` / `buildTaskInListCondition` / `canChangeCompletion` / `canChangeTaskMembers`；`task-lists` / `task-groups` / `task-settings` 追加 | 清单与分组的 org 单点子句、按 id / 按清单取行、日期与 PATCH 的校验与规划、清单项与成员的组合谓词 |
| PR-3b 补 | #6281 | `task-notification-text`、`task-delivery-protocol`；`task-reminders` / `task-notifications` 追加；`task-access` 加 `buildTaskByIdAnyStateCondition`；`task-list-access` 加 `buildTaskListsOfTaskCondition` | 文案与转义、投递退避 / 分类 / 优先级 / 新鲜度、扫描 SQL 片段、汇总到点判定 |

共同规则：时间一律显式传入 `now`；没有变化就没有事件；事件名只取锁 §4.2 两个闭集；不新增 `Intl.DateTimeFormat` 调用点；`src/tasks/` 不 import 数据库层、`pg`、`crypto`。任务 E 把门 20 的 harness 加严为从语法树读取导入（2026-10-09 已同意）。

### 2.4 服务与路由

**路由人口**（PR-3a 的鉴权门按 Express 路由栈枚举：8 + 13 + 30 = 51 条）：

| 期次 | 条数 | 路由 |
|---|---|---|
| M2 | 8 | `GET /api/tasks/context`、`GET /api/tasks?view=`、`GET /api/tasks/pending`、`GET /api/tasks/pending-count`、`GET /api/tasks/:id`、`POST /api/tasks`、`POST /api/tasks/:id/complete`、`POST /api/tasks/:id/reopen` |
| M3 | 13（11 写、2 读） | `PATCH /:id/parent`、`GET /:id/parent-candidates`、`POST /:id/assignees`、`DELETE /:id/assignees/:userId`、`PATCH /:id/completion-mode`、`POST /:id/followers`、`DELETE /:id/followers/:userId`、`POST /:id/leave`、`GET /:id/comments`、`POST /:id/comments`、`PATCH /:id/comments/:commentId`、`DELETE /:id/comments/:commentId`、`DELETE /:id` |
| M4 PR-3a | 30 | `PATCH /api/tasks/:id`（1）；清单 `/api/task-lists` 建 / 列 / 读 / 改名 / 归档 / 取消归档 / 动态（7）；成员 列 / 加 / 改角色 / 移除 / 转让（5）；清单项 列 / 加 / 移出（3）；清单 scope 分组 列 / 建 / 改名 / 删 / 摆放列 / 摆放写（6）；个人 scope 分组同形（6）；设置 `GET` / `PATCH /api/task-settings`（2） |
| M4 PR-3b | 0 | 无新 HTTP 路由（只有 producer、调度器、worker、通道） |
| M4 PR-3c | 0 | 无新路由；八个写入函数在提交后发信号 |
| M5 | 待定 | 重复 / 里程碑 / 依赖 / 字段 / 附件 / 投影开启 / 导出（按 S 编号；见任务 E 设计 §9，路由表待 PR-4a / 4b / 4c 的设计） |

**服务文件**：M2 `task-records.ts`、`task-create.ts`、`task-ids-runtime.ts`；M3 `task-structure.ts`；PR-3a `task-patch.ts`、`task-user-settings.ts`、`task-list-records.ts`、`task-group-records.ts`、`task-org-members.ts`、路由 `tasks-http.ts` / `tasks-lists.ts` / `tasks-settings.ts`（注册到同一个 router，路由栈是平的）；PR-3b `task-notification-flags.ts`、`task-notification-producer.ts`、`task-notification-delivery-worker.ts`、`task-notification-dingtalk.ts`、`task-scheduler.ts`；PR-3c `task-counts-realtime.ts`。

**事务与锁协议**（锁 §6.4；M2 起沿用）：所有改结构的写（创建、完成、重启、树、成员、切模式、软删、清单、分组）走同一形：事务第一条语句 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` → `acquireTaskStructureLock(client, orgId)` → 锁后重读决定本次写的全部行 → 调纯函数 → 只写纯函数说变了的东西，事件同事务。例外：评论写不进结构锁，各自事务内先对任务行取 `FOR KEY SHARE`；软删在结构锁之后对任务行取 `FOR UPDATE`，整条语句限时 3 秒，超时 409 `TASK_BUSY`（可重试）；设置 PATCH 只动本人一行，用行锁。读路径不进事务。调度 leader 锁在专用连接的独立事务里取，不与前两把共存。`tasks.version` 只在 `status` 真翻转与 `PATCH /api/tasks/:id` 的任一字段变化时 +1。

**错误契约**：不存在、不可见、他 org、已软删一律 404 `{ error: { code: 'NOT_FOUND' } }`；行级从不 403；资源面 403 体逐字 `{ error: 'Insufficient permissions' }`；校验失败 422（码名见各设计的路由表）；409 `VERSION_CONFLICT`（带 `currentVersion`）、`HAS_CHILDREN`、`TASK_BUSY`；服务层之外的错误一律 500 `{ error: { code: 'INTERNAL' } }`，不回显驱动错误码。空操作返回 200 且不写行、不写事件。成功体 camelCase，列表项沿用 M2 的 snake_case 六列。

**分页**（R15，PR-3a §7）：`limit` 1..100 缺省 100、`offset` ≥ 0、响应 `{ items, total }`、稳定排序键（任务 `updated_at DESC, id DESC`）、非法 422 `INVALID_LIMIT` / `INVALID_OFFSET`；回填 `/api/tasks` 与 `/pending`；M3 评论列表保留自己的 `INVALID_PAGE` 规则，两套并存（PR-3a §12-Q8）；cursor 推到 P2 之后（S34：M5 也不做）。

### 2.5 权限模型

1. **资源面（RBAC）**：每条路由 `authenticate` + `rbacGuard('tasks', 'read' | 'write')`。非管理员可达需要两件事：角色在 `role_permissions` 带 `tasks:read` / `tasks:write`，且 `user_namespace_admissions(user_id, 'tasks', enabled=true)` 有行；缺一即 403。`tasks` 不进非命名空间豁免集，不 seed 任何角色；`tasks:admin` 已 seed 但没有任何路由消费（R18）。
2. **实例面（行级）**：角色闭集 `{creator, assignee, follower, list-editor, list-reader, none}`，能力闭集 `{view, edit, complete, reopen, comment, attach, delete, leave}`，真相表 `TASK_ROLE_ABILITY` 叠加取并集；单对象路由先按 id 取行再 `can(roles, ability)`，不通过即与不存在逐字节相同的 404。`delete` 这一能力只属于创建人一种角色，`leave` 只属于关注人；关注人只读 + 评论 + 退出（§13-23）。零负责人任务只有创建人能完成 / 重启，且不进任何人的红点（R09）。
3. **直接角色与清单派生角色**：清单成员身份（`read` → `list-reader`；`edit` / `owner` → `list-editor`）自 PR-3a 起进入单对象能力解析（R04：`buildTaskByIdCondition` + `resolveTaskRoles(row, me, listMemberships)`），但**不进入**五个视角、pending 与红点（R04 ①：任务不会因为清单身份进入任务中心的视角）。清单只在它的 `org_id` 等于任务行的 `org_id` 时给角色。只有清单身份的人：详情 200，视角里看不到，经 `GET /api/task-lists/:id/items` 看清单里的任务。
4. **成员变更须直接角色**（2026-10-07 裁定）：增删负责人、增删关注人四条写只认创建人或负责人（`canChangeTaskMembers` 只看任务行的三列，没有传入清单身份的位置）；只有清单身份的编辑者保留 PATCH、设父、切模式、完成与重启、评论。详情以 `canManageMembers` 标志告诉前端隐藏成员控件。
5. **清单写授权**（R12 收窄版）：把任务加入清单要求清单 `add_item` 且调用者对任务有**直接角色**带来的 `edit`，且同 org，三条任一不满足是同一个 404（a1）；任务创建人可以不经成员身份把自己的任务移出任一包含它的清单，详情的 `listIds` 对创建人列出全部清单 id（a2）；成员支路移出要求清单 `remove_item` 且任务 `edit`。清单级动作由 `canListAction({ role, isCreator }, action)` 判定：`owner` 全部，`edit` 除转让外全部，`read` 只有 `view`；归档 / 取消归档对清单创建人额外放行；`created_by` 永不可移除（422）；`owner` 唯一，须先转让再退出；转让后原 owner 降为 `edit`。清单路由的第一道行级判定永远是「调用者是该清单的成员」，非成员得到与清单不存在相同的 404。归档不改变任务状态、可见性与可编辑性。
6. **在职校验**（R17 / N2，PR-3a §4.6）：写入负责人 / 关注人 / 清单成员 / 转让目标时，校验该用户按登录判据在本 org 在职（`user_orgs.is_active`、`users.is_active`、账号闸），一个共享 helper、一个 422 码 `INACTIVE_ORG_MEMBER`；回填到 M2 的 `POST /api/tasks` 与 M3 的加负责人 / 加关注人；发送通知时再复核一次（PR-3b）。操作者本人豁免。
7. **软上限**（A5、D14）：负责人与关注人各 50；清单成员 100；单任务所属清单 10；每 scope 分组 50；名字 100 码点（超长 `NAME_TOO_LONG`）；数量超限 422 `LIMIT`；M4 不设数据库硬限额（R14）。
8. **前端门**：路由 meta `requiresAuth` + `requiredFeature: 'tasks'` + `permissions: ['tasks:read']`（R-28，#6173）；入口与红点只在 `hasFeature('tasks') && hasPermission('tasks:read')` 时渲染；`tasks:write` 由后端判，前端按能力标志隐藏控件；放进请求路径的每个 id 先过路径段校验（空串、`.`、`..` 不发请求）。

### 2.6 通知管道（M4 PR-3b）

- **producer**：在写 `task_events` / `task_list_events` 的同一事务里，按任务 D 的收件人网格把通知意图写成 `task_notification_deliveries` 行，`ON CONFLICT (org_id, source_key) DO NOTHING` 幂等；四族 `source_key`（事件、提醒、每日汇总、清单事件）；只为有活跃钉钉集成的 org 写行；投递线未全开时不发查询、不写行。
- **触发闭集**（D13）：`completed`、`completed_by_any`、`reopened`、`deleted`、`commented`（P2 再加 `attachment_added`）；`self_completed` 与 `self_reopened` 两个事件不进通知闭集；`assignee_added` 默认也不进（R05-opt 未采纳）。收件人 = creator ∪ assignee ∪ follower ∪ list_member，排除 actor；同一人兼几个角色时只发一条，`recipient_role` 按 creator > assignee > follower > list_member；清单归档时通知该清单的创建人。N1：在 `all` 模式里，一次增删负责人若让任务翻转为完成或重启，同一事务里补记 `completed` / `reopened`，actor 取操作者。
- **提醒**（R06）：`remind_at` 缺省先看用户 `default_remind_policy`，缺省时，定时任务取截止前 30 分钟，全天任务取任务时区当天 18:00（经 `computeDateReminderOccurrence`）；写入时已过的提醒不入队、不补发；扫描窗 W = 2 小时；发送时任务已完成、已软删或 `remind_at` 已变则记 `skipped`；提醒只发给尚未完成的负责人，零负责人时发给创建人。
- **每日汇总**（R07）：内容 = 本人未完成的逾期任务 ∪ 今明两天截止；按用户 `time_zone` 固定 09:00；每（用户, 当地日期, 通道）恰一行，空汇总也写一行 `skipped` / `empty_digest`、不发送；扫描按发送时的在职判据过滤。
- **调度器**：自建 `TaskScheduler`；每个 tick 在专用连接的独立事务里经 `acquireTasksSchedulerLeaderLock` 取 `tasks-scheduler:leader`（`lock_timeout` 1 秒，没取到即 follower），取到才跑提醒扫描与汇总扫描；leader 事务 `SET LOCAL idle_in_transaction_session_timeout` 30 秒，扫描每页之前心跳；事务提交、锁随之释放之后，本 tick 的 leader 再跑一段有时间预算的投递循环；`stop()` 以停机信号让未开始的行立即退还。`TASKS_SCHEDULER_INTERVAL_MS` 是数值旋钮（缺省 60000，区间 `[5000, W/2]`）。
- **投递 worker**：claim（`FOR UPDATE SKIP LOCKED`）/ 租约 / 效果栅栏（`sending` 只在网络调用之前那一刻写入）/ 终态 CAS / 未处理行退还 / 过期清扫；每条 outbox 行的外部发送至多发起一次；过期的 `sending` 终态为 `outcome_unknown`，不重发；退避阶梯 1m / 5m / 15m / 1h / 6h，最多 5 次；每行预算 15 秒；逐行顺序为 物化 → prepare → 再物化 → 栅栏 → send。
- **钉钉通道**：复用仓库的钉钉客户端；收件人身份经 org 限定的目录三表 join 解析，发送配置只取产生该身份的那一行集成；出站地址只接受 `https` 的钉钉域名；错误文本先截到 4096 再脱敏、再截到 240（worker 写 `last_error` 前的 1000 上限在其后不再生效）；日志不写标题 / 正文 / token / 上游原文；正文末行恒为 `编号 <outbox 行 id 前 8 位>`；用户文本经 markdown 转义，其中半角冒号渲染为全角冒号（2026-10-09 裁定）。
- **开关**（锁 §10）：`TASKS_SCHEDULER_ENABLED`、`TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED`、`TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED`，默认 OFF，严格 `'true'`，都以 `TASKS_ENABLED='true'` 为前提；同 PR 登记 flag manifest（门 18）。真值表：调度器关 ⇒ 全无；调度器开、worker 关 ⇒ 扫描空转、不写行、不 claim；worker 开、通道关 ⇒ claim 为零；三者全开 ⇒ 只限有活跃钉钉集成的 org 产出与发送。
- **不做**：新 HTTP 路由、账本清理作业（R13：M4 不做硬删，outbox 行一直保留）、免打扰、deep link、其他通道。

### 2.7 红点实时失效（M4 PR-3c + 前端 FE-c）

- 事件名 `tasks:counts-updated`；房间 `auth-user:<userId>`（socket 在令牌验证后由服务端加入，客户端不发 join）；载荷恒为 `{}`，不含计数与任务字段；收件人 = 本次写入前后负责人集合的并集，关注人不收；只在写入事务提交之后发送，回滚零发送；发送失败只记日志，不重试、不进 outbox。
- 触点由谓词而不是枚举决定：写入提交之后，若 `buildTaskPendingCondition` 读到的某个输入变了——`task_assignees` 的行集合、每位负责人的 `completed_at`、`tasks.status`、`tasks.deleted_at`、截止四列或 `time_zone`——就发一次；对应八个服务函数：`createTask`、`completeTask`、`reopenTask`、`addAssignee`、`removeAssignee`、`switchCompletionMode`、`deleteTaskById`、`patchTask`（动到截止字段或时区时）。单测里有一格把写入者普查钉在源码上，新增写入者而不接信号即红。
- 接线在 `MetaSheetServer` 构造函数里经服务器自己的 websocket API 转到 `CollabService.broadcastTo`；socket 服务是进程内 adapter，多进程部署下其余客户端等下一次轮询。
- 前端（FE-c）：`useTasksCountsRealtime` 订阅该事件，一个 500 ms 窗口里的信号合为一次重拉 `/pending-count`（带查看者时区头）；60 秒轮询保留且是必需的另一半；feature 关闭或退出登录时红点卸载即断开。

### 2.8 前端面

| 期次 | 路由 / 组件 | 要点 |
|---|---|---|
| M2（#6092） | `/tasks`、`/tasks/:id`（`TasksView.vue`）；顶部导航入口与常驻红点 `TasksTodoBadge.vue` | `GET /api/tasks/context` 分五态（ready / org_missing / unavailable / forbidden / error）；缺组织引导恰三触发（context `orgId === null`、读降级 `org_missing`、写 422 `ORG_MISSING`），`predicate_error` 不引导；红点三态常驻节点、读失败绝不渲染成 0、60 秒轮询、404 停止轮询；真 fetch，无 mock 分支；列表与详情共用组件，代次守卫丢弃晚到结果 |
| M3（#6159） | 详情页加法：子任务树、负责人 / 关注人增删、完成模式切换、评论区（逐页读到 `total`，按 id 去重）、带内联两步确认的删除 | 详情解析把 `parentId` / `depth` / `children` 当一组，兼容 M2 形状；按详情返回的 `canEdit` / `canDelete` / `canComment` / `canLeave` 隐藏控件；错误码逐一映射文案；晚到结果用 token 守卫；一次一个动作 |
| M4（#6265） | `/tasks/settings`（`TasksSettingsView.vue`）、`/task-lists/:id`（`TaskListView.vue`）、左栏 `TaskListsSidebar.vue`、`TaskListMembersDialog.vue`、`TaskGroupBoard.vue`（清单与个人两种 scope）、`TaskPersonalGroups.vue`、详情 `TaskDetailEditor.vue` / `TaskDetailLists.vue`；`labels.ts` 中英文案（R20 取 (a)，回填 M2 / M3 文案）；`useTasksCountsRealtime.ts` | 详情编辑走 `PATCH` 带 `expectedVersion`，409 后只保留用户改过的字段（[fe-19]）；成员对话框按 `myRole` 推断控件并有焦点管理；分组板拖拽 + 键盘替代、乐观更新失败回滚；红点 `badgeScope: 'off'` 常驻节点无数字；成员控件按 `canManageMembers` 隐藏；所有新写函数的路径段先校验 |

接线（锁 §5.3、门 21 / 22）：每个 `tasks*.spec.ts` 同 PR 登记进 `apps/web/scripts/run-required-web-tests.sh` 的 exec 块、`.tokens` 清单与 `.github/workflows/tasks-web-guard.yml` 的逐文件参数，D = T = G 三集合相等；路由 meta 由 `tasks-routes.spec.ts` 按门 22 投影断言。

### 2.9 Feature gating 与部署

- `TASKS_ENABLED === 'true'`（精确字符串）才挂路由；会话 feature payload 的 `tasks` 键由 `tasks/feature-flag.ts` 给出（R-28）；三个 P1 开关见 §2.6；M5 的开关以 PR-4b / 4c 的设计为准。每个新 `TASKS_*_ENABLED` 读点同 PR 登记 `scripts/ops/global-history-flag-manifest.mjs`（门 18 的发现式核对）。
- 五段部署链（锁 §5.4）：合并 → 构建 → 发布 → 部署 → 迁移是五个独立动作；`main` 推送只构建不发布；发布与生产部署只经 `docker-build.yml` 手动 dispatch；staging 只由 window-runner 部署，`action=migrate` 先于 `action=deploy`。
- M4 迁移的部署耦合（PR-3a §9.2、§12-Q10）：PR-3a 之后 M2 / M3 的任务路由在角色解析时读 `task_list_items` / `task_list_members`，`/pending-count` 读 `task_user_settings`；凡 `TASKS_ENABLED='true'` 并运行这份代码的环境必须已应用 M4 迁移。合并后 staging 的共享 `deploy` 动作会在换上新镜像之后、于迁移对齐门处失败，直到 owner 二选一（授权 `action=migrate`，或把该迁移列入排除清单并保持 `tasks_enabled=false`）；冒烟脚本的 preflight 已加三张 M4 表的存在检查。
- 回退分三层：代码 revert；迁移只在它是该环境最近一条时可 `--rollback`；已写入的业务数据（outbox 行、`outcome_unknown` 行的补偿）需 owner 逐单授权。

---

## 3. owner 裁决登记（只列编号、日期与一句规则）

| 日期 | 条目 | 规则（一句） | 登记位置 |
|---|---|---|---|
| 2026-09-26 | §13-5 | 谓词两形态与从属链；投影侧共用 WHERE 文本生成器 | 锁 §9、§13 |
| 2026-09-26 | §13-9 | 完成 / 重启对称：any 模式其余人同一时刻置完成并记 `completed_by_any`；any 重启 = 全部；增删人 / 切模式按计划 §5-4 | 锁 §9、§6.2 |
| 2026-09-26 | §13-10 | (a) `tasks` 不进豁免集；(b) 不 seed 角色；(c) 三码 `tasks:read` / `tasks:write` / `tasks:admin` | 锁 §9、§5.1 |
| 2026-09-26 | §13-11 | 投影读路径复用 `loadDeniedRecordIds` 的新 sibling；deny 查询失败必抛 | 锁 §9、§7 |
| 2026-09-26 | §13-12 | 真库 lane 取 (b)：`tasks-realdb` 去 paths、声明 `merge_group`、四步追加 | 锁 §9、§5.2.1 |
| 2026-09-26 | 拆分 / 起任务 B | M2 拆为后端与前端两个 Draft；任务 B 纯函数先行 | 锁抬头；任务 B 设计 |
| 2026-09-28 | A1–A7 | 任务 C 七项取舍接受（含 A6 / A7 改 `task-completion.ts` 的 `wasDone` 语义） | 任务 C 设计 §6 |
| 2026-09-28 | 门 8 / 门 13 | 门 8 的 A 支与非法 IANA ⇒ 422 改到 M4；门 13 接受构造 `MetaSheetServer` 不 `listen()` | 锁 §12 门 8、门 13（落文）；PR #5845 评论 5861224994 |
| 2026-09-28 | §12 ratify | 门表 ratify；合并序 #5845 → #6062 → #6092 → #6123 | PR #5845 评论 5871552862 |
| 2026-09-28 | 起任务 C | M3 纯函数开工 | 任务 C 设计 |
| 2026-09-29 | R-28 | `/tasks` 的路由记录与导航入口都由会话 feature `tasks` 门控（取代锁 §13-38 的缺省乙） | 锁脚注；#6173 |
| 2026-09-29 | staging（M2） | 发布 `main` 镜像、迁移、`tasks_enabled=true` 部署与非管理员冒烟；A-3 迁移继续排除 | #6158、#6167、#6177 |
| 2026-10-07 | M3 契约追认 | 新码 `COMMENT_INVALID_CHAR`、`TASK_BUSY`；软删行锁语句限时 3 秒；`POST /api/tasks` 去重后 50 个负责人上限；标题含 U+0000 或不成对代理项 ⇒ 422 `INVALID_TITLE`；M2 端点的三处行为变更 | 仓库内无裁决登记（owner 2026-10-07；#6229 正文仍写「待 owner 追认」，M3 后端设计 §3.7 末仍写 3 秒「待 owner 定」；可由 owner 在 PR 上补一条评论登记）；条目正文见 M3 后端设计 §2、§3.8 的第五轮修订 |
| 2026-10-07 | R01–R23、N1、N2 | M4 裁决包按推荐值落槌；R04 含 `buildTaskByIdCondition` 与 `i-m4`；R05 细则按 D13，不含 R05-opt；R12 取 PR-3a 收窄版 (a1) / (a2)；R15 `limit` 缺省 100；R20 取 (a)；N1 翻转补事件；N2 在职校验回填 M2 | PR-3a 设计 §11、§12；锁 R01 增补 |
| 2026-10-07 | [fe-19] | 409 后只保留用户改过的字段，其余取重读值，下次保存用重读后的 `version` | M4 前端设计 §11、§12-Q15 |
| 2026-10-07 | 起任务 E | M5 纯函数开工（S32 第一句） | 任务 E 设计 |
| 2026-10-07 | staging（M3） | 发布 `main` `7137688372` 镜像并按既有授权 migrate → deploy（`tasks_enabled=true`）→ 冒烟；A-3 继续排除 | 仓库内无裁决登记（owner 2026-10-07）；run 编号见本文 §4.4 |
| 2026-10-07 | runner PR | 冒烟脚本随 runner 打包、补 M3 冒烟用例；审阅 0 P1 / P2 且必需检查全绿后合并 | 未登记（owner 2026-10-07；#6278 的正文、评论与审阅里都没有） |
| 2026-10-07 | 直接角色规则 | 增删负责人与关注人只认创建人或负责人；清单派生编辑者保留 PATCH、设父、完成 / 重启、切模式、评论 | PR-3a 设计 §3.4、§6.3（`[own-53]`） |
| 2026-10-09 | S01–S37 | M5 裁决包按推荐值落槌；PR-4a / 4b / 4c 在 M4 合并授权后起 Draft（S32 第二句） | 任务 E 设计抬头、§9 |
| 2026-10-09 | 通知正文冒号 | 通知正文里的用户文本把半角冒号渲染为全角冒号 | PR-3b 设计 §8.3 |
| 2026-10-09 | 门 20 变严 | harness 增加从语法树读取的静态导入检查 | 任务 E 设计 §7 问题 4、§9 |

**尚未裁 / 尚未发生**：#6248 的 owner 亲写确认评论（锁 §14-2）与锁抬头的评论 id 回填；任何 M4 / M5 PR 的合并点名；`tasks-realdb` 追加进 `main` 必需检查（合并后的 owner 步骤）；各 PR 的 owner 问题（§7）。

---

## 4. 验证证据（按 PR）

通用做法：实现与审阅由不同代理承担；每个 PR 推送前过独立多视角闸审，每条发现三票反驳，0 P1 / P2 才推送；关键守卫逐一做源码变异（备份 → 改 → 跑 → 还原 → 逐字节比对，不用 `git checkout`）；真库 lane 在新建的一次性库上从空库全量迁移，用完即删；变异只在一次性检出里跑。用例计数按锁门 17 的口径（`it.each` 按表行展开）与 verbose 日志对账。

### 4.1 已合并

| PR | 单测 / 类型 | 真库 lane | 鉴权门 | 变异 | 独立闸审 | 其他证据 |
|---|---|---|---|---|---|---|
| #5845 M0 | docs-only，无产品测试 | — | — | — | 锁稿十七轮对抗闸（第十五轮 1 P1 / 6 P2 / 10 P3，逐条机核见 `task-feature-m0-development-20260917.md` §6） | 普查命令可复现；必需检查 13/13 绿 |
| #6086 任务 B | `tests/unit/task-*.test.ts` 5 文件 295 格；`tsc` 零输出；门 20 静态两条零命中 | 审阅方在本地 PG 15.17 对拍：门 19 的 49 格、pending SQL 198 条查询 343 个任务、418 时区 × 365 天、2,814 个 id 字符串，均 0 差异（审阅证据，非分支测试） | — | 第 3 轮新测试对修复前代码 15 条失败 | 3 轮（R1 2 P1 / 8 P2 / 7 P3；R2 两 P1 关闭、1 P2；R3 ACCEPT） | 查看者时区校验穷举约 100 个拼写与 BMP 全字符插入无绕过 |
| #6062 M2 后端 | `task-pure-no-io` 5、`task-advisory-locks` 5、`task-ci-coverage-enumeration` 4、`task-gate19-identities` 6、`tasks-auth-ci-wiring` 2；CI `test (20.x)` 收集 18339 | 4 文件：`task-p0a` 13、`task-read-path` 57（含 `i-m2` 49 格）、`task-rbac-trust` 17、`task-completion-grid` 6；`tasks-realdb` run 36408109252 通过（93 格） | `vitest.tasks-auth.config.ts` 8 格（门 1 四格 + 401 / 403 / 200 对照） | 探针①（assigned 臂换 `FALSE` ⇒ 三端红、count 0）、探针②（置反 `assignee.complete` ⇒ complete 404、列表三端绿）、门 8 回退改 UTC ⇒ 红、门 1 删 org 子句 ⇒ 两面出现 org B；闸方各轮另记 | 15 轮（第 2 轮 2 P1 / 5 P2 … 第 8 轮增量 APPROVE 1 P1；第 14 轮 APPROVE 0 P1 / 0 P2；第 15 轮终表 29 行 27 MET / 2 MOVED） | 门 1 的 §12.0 九项前置逐格标注；provenance pin 重算；`sealed-export-package-provenance` exit 0 |
| #6092 M2 前端 | 12 个 spec 256 格；`vue-tsc` 0 | — | — | 8 项逐一变红（`canUseTasks`、红点失败清零、引导四处、晚到守卫、`listPageToken` 等）；第 3 轮审阅另对 47 个守卫逐一变异 | 4 轮（0 P1 / 5 P2；3 P2；2 P2；门 15 对账两次） | 本地端到端：一次性工作树合并 #6062，`TASKS_ENABLED=true` 起后端 + vite，Playwright 驱动真浏览器跑通管理员全流程（新建 / 列表 / 完成 / 重开 / 切视角）；详情页未在真浏览器复测 |
| #6123 任务 C | 任务单测 11 文件 427 格；全量 14786；`tsc` 零输出；门 20 自动发现 | — | — | 11 项列出的守卫逐一变红（1–3 格）；审阅第 1 轮另 50 个、第 2 轮 53 个 | 4 轮（0 P1 / 2 P2；2 P2；1 P2；第 4 轮 APPROVE 0 P1 / 0 P2）；穷举服务模型 178 可达状态，卡死 0、无事件翻转 0、违反 any 不变量 0 | A1–A7 于 2026-09-28 接受 |
| #6229 M3 后端 | `tsc` 0；全量单测 17788 passed / 1665 skipped（第四轮后）；新单测 `tasks-route-errors`、`task-deletion-lock-errors` | 7 文件 196 格 ×3（第五轮，PG 15.17；第 1 遍既有文件两格 `socket hang up`，第 2、3 遍全绿；`task-m3-tree` 25、`-membership` 45、`-comments-deletion` 33）；迁移 `--rollback` / 重建往返（首轮） | 23 格（13 条 M3 路由逐条的门 1 / 门 2 / 门 16 格） | 第一轮 68（66 红、2 按预期存活）、第二轮 62 个源码变异全红（另 7 个结构变异在副本库）、第三轮含 2 个等价存活、第四轮 6 全红、第五轮 1 | 5 轮（验证记录按处置项计 25 / 36 / 15 / 5 / 6，PR 正文按原始条目计 28 / 37 / 15 / 9 / 10），全部处置；第四轮生产代码零改动、第五轮只改一处注释 | 合并前对 `main` `8e2e40d125` 合并预演（PR 正文）：自动合并无冲突、`tsc` 0、lane 196 / 196 ×3、`tasks-auth` 23 / 23；squash 为 `57621d2403` |
| #6159 M3 前端 | 14 个 spec 469 格；与后端闸各轮对齐后的四次重跑 455 / 459 / 463 / 465 全绿（验证记录 §6）；`vue-tsc` 0；token manifest 537 MATCHES | — | — | 第 1 批 39（37 首跑即红、1 补等待后红、1 等价删冗余）；第 2 批 21 全红；对齐后端各轮 21 + 5 + 4 + 4（1 等价） | 五角度一轮：52 条意见，21 成立、15 推翻、16 未判定 → 7 条重新三人核验，6 成立；后端闸转来的前端项逐轮处理 | 合并时 head 已含 `main` `57621d2403`，CI 24 绿 / 1 跳过；真浏览器联调 NOT RUN（全部 mock） |

### 4.2 Draft（未合并）

| PR | 单测 / 类型 | 真库 lane | 鉴权门 | 变异 | 独立闸审 | CI / 其他 |
|---|---|---|---|---|---|---|
| #6186 任务 D | 任务单测 22 文件 684 格，第四轮后 689 格；全量 17999 / 0 失败；两条 CI `tsc` 命令零输出；eslint 零新增 | — | — | 28 处（9 手工 + 19 脚本化，还原后 `git diff` 哈希一致）+ 第四轮 5 处，全部变红 | 4 轮独立复核（第 3 轮 13 项含两处实测确认的真缺陷：`offset: 1e300` 静默通过、`2026-02-30` 静默滚动；第 4 轮 6 项 0 P1） | head `50feb0d01b` CI 26 绿 / 1 跳过；其后只改注释与文档的 `630e85ead8` 在托管 runner 作业未启动期间推送，检查未能启动 |
| #6248 锁 R01 增补 | 锁内两条自检（`arm-set` 键不重复、门号 1–26；R01 涉及的 18 行逐字存在）exit 0，负控（删 `M4\|23\|整门` 或 `M4\|19\|清单角色`）exit 1 | — | — | — | —；PR 正文列 13 处「起草方设计（需要 owner 确认）」与 1 项「需要 owner 回答」（§7） | CI 21 / 21 绿；抬头评论 id 占位待 owner 亲写确认后回填 |
| #6266 M4 PR-3a | 任务单测 29 文件 1160 格；全量 20445（本机 5 个文件因环境失败，与本 PR 无关）；`tsc` 0 | 16 文件 708 格 ×3（PG 15.17）：`task-m4-schema` 59、`-list-roles` 50（含 `gate19m4` 25 格）、`-paging-settings` 77、`-dates` 107、`-lists` 66、`-list-members` 44、`-list-items` 25、`-groups` 38、`-org-members` 46 + M2 / M3 七文件 93 + 103；PG16：本 PR 的记录记为 NOT RUN（本地只有 15.17）；这 16 个文件 708 格只作为子集在 PR-3b 与 PR-3c 的 16.15 lane 里跑过（§5） | 86 格（P0-A 8 条 + M3 13 条 + M4 30 条路由的门 1 / 门 2 / 门 16，路由人口 51 有负控；清单第二租户读格在 trust-off 下） | 手工 458（457 红、1 等价）；文件内负控（门 1 / 8 / 13 / 19 与负控 1–7）每遍 lane 或鉴权门都跑 | S1–S3 + S4 闸、S5 + 修复切片闸（7 条：0 P1、1 P2、4 P3、2 NIT）、S6 + S7 闸（9 条 8 成立，处置见记录 §S67F.1）、S8–S10 增量闸（3 P2 + 14 P3 / NIT）；每轮有修复切片，最后一轮修复本身未再过闸 | 迁移在一次性库 `up → down → up` 与 `search_path` 置空的 `pg_restore` 核过；`staging-tasks-smoke` preflight 加三张表；head `68e40323bd` 在托管 runner 作业未启动期间推送，52 项检查未能启动 |
| #6281 M4 PR-3b | 任务线单测 38 文件 1519 格（S7 时 1503）；全量 19024 passed（失败的是记录里同一组 5 个与本线无关的文件）；manifest 39 / 39、102 / 102；`tsc` 0 | 20 文件 795 ×3（另一台机器 PostgreSQL 16.15，记录 §S-gate2.4；新文件 `task-m4-outbox` 21、`-delivery` 30、`-scheduler` 25、`-dingtalk` 11） | 86 | 不同 mutant 310（S0 13、S1 62、S2 35、S3 15、S4 42、S5 47、S6 32、门审修复 42、再门审修复 22），309 红、1 等价；执行 367 次（记录 总览.3） | 设计评审 34 条（33 采纳、1 部分采纳）；S2–S6 门审 6 项确认 + 14 行 P3 / NIT 全处置（停机退还、leader 会话界限与心跳、钉钉分类负控、floor 语句钉住、脱敏规则、措辞）；S7 之后的再门审 2 项确认 + 1 项未确认与 17 行 P3 / NIT：2 项全部处置，18 行里 15 行改正或加格、3 行记为已知限制（记录 总览.4）；其后的独立核验 0 P1 / 0 P2（PR 正文「再核验」） | 以非 `main` 分支为基，`plugin-tests`、`web-tests`、contracts 与 `migration-replay` 不触发（记录 总览.5） |
| #6269 M4 PR-3c | 新单测 `task-counts-realtime` 17、`task-counts-touchpoints` 62（含写入者普查格与「提交后才发送」前提格）；任务子集 31 文件 1239；`tsc` 0 | 首轮本地 PG 15.17：17 文件 727 ×3；闸修复后：17 文件 729 ×3 在另一台机器的 PostgreSQL 16.15（记录 §10.3；新文件 `task-m4-realtime` 21，`gate26\|` 前缀，候选） | 86 | 37 全杀；闸修复后 32（31 杀、1 按设计存活）+ 真库 7 全杀；文件内负控甲 / 乙 / 丙 / 关注人与接线负控各有「控件的控件」 | 闸审 14 条全处置（记录 §10.2）：1 P2（门 26 没有一格让操作者本身是负责人）、5 P3、8 NIT；闸审另做了随机写入对拍、并发写入与真实 socket 连接的核对（PR 正文） | R01 (iii)：在 PR-3a + PR-3c 的 head 上把锁 `M2\|` 27 行、`M3\|` 2 行逐行重跑并记控件（验证记录 §6）；head `3edd133ae0` 在托管 runner 作业未启动期间推送，39 项检查未能启动 |
| #6265 M4 前端 | 24 个 whole-file spec 1933 格；`vue-tsc` 0；必需 web lane 本地全跑；D = T = G = 23 | — | — | 599（595 红、4 等价） | 设计评审 27 条全处置、无驳回（设计 §15）；实现闸审 8 P2 + 1 未确认项 + 18 P3 / NIT 全处置（验证记录「闸审之后的修复」） | 推送前按 head 的树把提交历史重建为单个提交；真机走查一次（Chromium、中文、PR-3a 后端 `f4a0eb532c` + 一次性库）11 步都得到预期结果，顺手发现并修了写后焦点丢失（`[fe-48]`）；head `f82f24b8ab` 与 `5e73a6b8f3` 都在托管 runner 作业未启动期间推送，检查未能启动 |
| #6249 任务 E | 任务单测 30 文件 958 格（另按三个进程时区各跑一遍）；门 20 35 / 35；`'x'` 探针与 import 图 44 / 44；全量 20199 / 20243（5 个已知环境失败文件）；两条 `tsc` 零输出；eslint 零问题 | — | — | 76 / 76 在最终代码重跑；复审后新守卫 77 / 77 | 闸审 0 P1（PR 正文）、10 P2（验证 §7.1）+ 22 P3 / NIT，全部处置（其中 3 条推送时的动作在推送时完成，验证 §7.2） | head `82eea91fc3` CI 25 绿 / 1 跳过；只改标签的 `d6c84264ff` 在托管 runner 作业未启动期间推送，检查未能启动 |
| #6278 runner 冒烟 | runner 自检 385（pipeline 198 + 任务冒烟 harness 187，含 149 个错形回答子测试）；清理助手 19（真库 19 / 19） | 清理助手在真实 PostgreSQL 上按四个冒烟范围验证（事务内回滚） | — | 全断言扫描 195 杀 194（1 等价）；具名 34；闭包扫描规则 15 处删除各被抓；第二轮 202 杀 201；第四轮拒绝规则 8 个与 no-git 钉 18 个全杀（1 个对照全绿）；第五轮 10 杀 9（1 存活为环境变量旁路，已记） | 5 轮复审：首轮无级别标注；第二轮 1 P2（清理按 API 回答 id 删行）；第三轮 1 P1（清理助手用户前缀过滤的 SQL 参数类型）+ 1 P2（harness 不核对目标 id）+ 1 P3 + 3 NIT；第四轮 1 P2（考勤三冒烟改为拒跑）+ 5 P3 + 3 NIT；第五轮 1 P2（`smoke` 默认值未钉）+ 7 P3 / NIT；未改代码的 P3 / NIT 列在 PR 正文 | 本地端到端对真实后端多次 PASS 99 断言（前几轮 PG 15.17，第四轮在另一台机器的 PG 16.15、未在 15 上重跑），代理改写外部 id 的两次按设计失败且外部行不变；条件合并授权见 §3（PR 上无登记）；head `c980f78015` 在托管 runner 作业未启动期间推送，必需检查未能启动 |

### 4.3 门表计分状态

- M2 退出集合（锁 `arm-set` 的 `M2|` 行）于 2026-09-28 随 §12 ratify 计分（PR #5845 评论 5871552862）；`M3|3|增删人切模式` 与 `M3|6|整门` 由 #6229 的 `task-m3-membership` / `task-m3-tree` 承载。
- M4 行：锁里既有的 `M4|8|A支与非法IANA`、`M4|19|清单角色` 由 PR-3a 的 `task-m4-dates`（含运行期定极性的 A 支与两个生产码 mutant）与 `task-m4-list-roles`（`gate19m4` 25 格、`any_role` 清单臂 mutant）承载；R01 新加的子集行（`M4|1|清单第二租户`、`M4|2|清单路由`、`M4|8|提醒与每日汇总`、门 1 / 2 / 13 / 17 / 18 / 20 / 21 / 22 的新表面）与新门 23–26 的格分别落在 PR-3a、PR-3b、PR-3c、前端，在 #6248 合并之前一律候选、未计分；`i-m4` 块尚未写进锁（PR-3a §12-Q1）。
- M5 行（`M5|7`、`M5|9`、`M5|10|P2子集`、`M5|19|投影端`）首个可跑为 M5，NOT RUN；候选 M5-a…g 与门号取决于 R01 落锁（S31）。

### 4.4 staging 实跑

| 日期 | 动作 | 结果 |
|---|---|---|
| 2026-09-29 / 09-30 | 发布 `main` 镜像（run 36539328177，09-29）→ migrate（run 36604689198：备份、克隆演练、应用 11 条含任务两条，414 → 425，A-3 未应用）→ deploy `tasks_enabled=true`（run 36605301193）→ `smoke=tasks`（run 36605579996）；后三步在 09-30 | `TASKS_API_DB_SMOKE_PASS` 19 / 19：准入前 context 403、授予后 200；新建 / 视图 / 完成 / 重开 / 详情全 200；残留 0；考勤设置前后一致 |
| 2026-10-07 | 发布 `main` `7137688372`（run 37632249552）→ migrate（run 37633129605：425 → 430，含 `task_comments`；A-3 三个检查点仍排除）→ deploy `tasks_enabled=true`（run 37634034316）→ `smoke=tasks`（run 37634643293，部署机仓库同步跳过） | 19 / 19 PASS；staging = `7137688372` + `TASKS_ENABLED=true`；冒烟只覆盖 M2 路由，M3 路由的冒烟在 #6278 |

回退规则：同 SHA 以 `tasks_enabled=false` 重部署；迁移已应用，不能回到旧镜像。

---

## 5. NOT RUN（明确未跑）

1. **CI**：托管 runner 作业在 2026-10-08 至 2026-10-09 间两度未启动（与代码无关），期间推送的 head 的检查在数秒内以失败结束、零步骤，不代表测试结论：#6186 `630e85ead8`、#6266 `68e40323bd`、#6269 `3edd133ae0`、#6265 `f82f24b8ab` / `5e73a6b8f3`、#6249 `d6c84264ff`、#6278 `c980f78015`。托管 runner 已于 2026-10-09 恢复；各 head 须重跑；以 PR-3a 分支为基的 PR（#6281、#6269）不触发 `plugin-tests`、`web-tests`、contracts、`migration-replay`，这些守卫只有本地结果。
2. **真实钉钉**：PR-3b 的 token 请求与发送都是替身，没有任何网络请求；R01 第 ④ 部分（`post-merge|23|staging真投递`：在 staging 做一次真实投递、outbox 留下一行）要 runner 加三个开关的输入、钉钉凭据与目录绑定，另行授权。
3. **M4 上 staging**：M4 迁移未应用到任何共享环境；PR-3a §12-Q10 的二选一未裁；三个 P1 开关在所有环境关闭。
4. **R01 (iii) 的最终 head**：PR-3a + PR-3b + PR-3c + M4 前端合在一起的 head 不存在；`M2|` / `M3|` 全部行只在 PR-3a + PR-3c 的 head 上重跑过；门 26 整行要 PR-3c 与 FE-c 同时在才可能绿。
5. **真实 socket 端到端**：浏览器真的收到 `tasks:counts-updated` 并重拉、两个后端进程下的投递，都没有做；PR-3c 的接线格停在 `CollabService.broadcastTo`。
6. **PostgreSQL 版本**：本地只有 15.17；CI 的 postgres:16 容器与 PG14（`plugin-tests`）、postgres:15-alpine（`migration-prod-image-parity`）未在 M4 分支上跑过；另一台机器的 16.15 只覆盖 PR-3b（lane 792 ×3 与鉴权门 86，记录 §S7.4）、PR-3c 闸修复后那一轮（lane 729 ×3 与鉴权门 86，记录 §10.3）与 runner 第四轮起的端到端（记录 §10.3，未在 15 上重跑）；PR-3a 自己的记录把 postgres:16 记为 NOT RUN，其 16 个 lane 文件 708 格只作为 PR-3b / PR-3c lane 的子集在 16.15 上跑过。M3 后端合并前本地未跑 16，合并时由 CI 的 postgres:16 覆盖。
7. **真浏览器**：M3 前端没有真浏览器联调；M4 前端只有 FE-8 的一次 Chromium 中文走查，Firefox / Safari、英文界面、两标签并发 409、大数据量、页面级写后焦点都没有；闸审之后的焦点修复只在 jsdom 验证。M2 的本地端到端只跑了管理员路径，`following` / `delegated` / `any_role` 视角与非零红点未覆盖。
8. **staging 冒烟的覆盖面**：现行冒烟只覆盖 M2 路由；M3 路由的冒烟随 #6278，合并后才能在 staging 执行；考勤三个冒烟（ae4、mp6、otbank-v18）被 runner 拒绝，重新启用归考勤线。#6278 的 runner 工作流本身（Actions 上的 tar / ssh 与远端执行）从未派发：bundle 的打包与平铺解包用本地 `tar` 复现，容器拷贝用记录型 `docker` 与本地拷贝复现，没有对真实容器执行 `docker cp`（验证 §5）；合并后的首次 `smoke=tasks` 派发就是它的首跑。
9. **锁与门表**：`i-m4` 未入锁；门 19 的 M4 视图格、门 21 / 22 的 M4 行、门 23–26 全部候选；门 9、锁序控件、`src/multitable/task-*` 扫描根首个可跑为 M5；M5 候选门 M5-a…g 未编号。
10. **全量单测**：PR-3c 闸修复那一轮与 PR-3b 的若干切片没有重跑全量（只跑任务子集），上一次全量在各自记录的 head 上；本机 5 个与本线无关的文件（4 个 multitable-recovery、1 个考勤插件布局）因环境失败，未修。
11. **其他**：M3 契约里 `TASK_BUSY` 的 3 秒是否改 1 秒待 owner；PR-3b §13-Q23 / Q24 的两种情形没有格；leader 会话的 TCP keepalive 界限未采用；Node 18 未跑（`main` 已去掉矩阵）；任务 D 的 `isInDailyDigest`（TS）与 `buildTaskDailyDigestCondition`（SQL）的双形对拍留给 PR-3b 的真库格（`task-m4-scheduler` 有一格让两形在同一批 10 个任务上选出同样的 6 个，记录 §S5.5）。
12. **独立复闸**：PR-3a 的 S8–S10 闸修复本身未再过闸（其记录如此声明）；PR-3b 的再门审修复（S-gate2）之后另做了一轮独立核验（0 P1 / 0 P2，PR 正文「再核验」），其后只改了文档与源码注释的措辞，未再过闸。

---

## 6. 合并计划与仍需的门

### 6.1 顺序与各自前置

| 序 | PR | 前置（除 owner 点名外） |
|---|---|---|
| 1 | #6248 锁 R01 增补 | owner 在该 PR 上亲写确认评论（锁 §14-2），回填抬头的评论 id 并再推；锁内五句仍说 §12 门表 PROPOSED 的陈旧文字是否勘误由 owner 定；合并后 R01 的 `M4\|` 子集行与门 23–26 才计分 |
| 2 | #6266 PR-3a | 以 `main` 为基；必需检查在 CI 恢复后全绿；R01 (i)(ii) 的格由 lane 与鉴权门承载；#6186 拟按「被本 PR 取代」关闭（§12-Q15）；合并后 staging 的二选一（§12-Q10）必须在任何 `tasks_enabled=true` 的部署之前裁定；`tasks-realdb` 在 `main` 跑过之后由 owner 追加进必需检查（门 17 ③）；合并前按 `main` 届时的最大迁移前缀复核本 PR 的迁移名仍排最后，否则改名、PR-3b 分支随之改名（PR 正文「合并前须知」） |
| 3 | #6281 PR-3b | 以 PR-3a 分支为基的单提交（父提交为 #6266 的 head）；与 PR-3c 在六个回调上的冲突按 PR-3c 设计 §10 的唯一非机械一步处理；无 DDL；三个开关的 staging 输入另需 runner 改动（§13-Q8） |
| 4 | #6269 PR-3c | 叠在 #6266 上；合并时在包含 PR-3b 的 head 上重跑 R01 (iii)（`M2\|` 27 行、`M3\|` 2 行）；门 26 后端格与 FE-c 前端格同行 |
| 5 | #6265 M4 前端 | 在 PR-3a 之后；FE-c 已推入；必需 web lane 与 `plugin-tests` 的 `.tokens` 守卫在 CI 上跑过；真机与 PR-3c 后端的联调仍 NOT RUN |
| — | #6249 任务 E | M5 纯函数，只建新文件；合并归 M5 的点名；任务 D 下次 rebase 时把 `addCivilDays` 改为 import |
| — | #6278 runner | 条件合并授权（owner 2026-10-07，PR 上无登记）：审阅 0 P1 / P2 已满足，必需检查全绿后合并；合并后 staging `smoke=tasks`（不重发布、不重部署），这是其 runner 工作流的首次派发（§5） |
| — | #6126 M3 契约 | 仍开着的 Draft（head `c117ab06ca`，base `main`）；实现已由 #6229 落 `main`（该 PR 评论 5903541072 已说明实现另开新 PR），契约正文以 `main` 的 M3 后端设计为准，PR 正文里的剩余步骤已过时；本文建议关闭为「已被 #6229 取代」或 rebase 后作 docs-only 合并，由 owner 点名 |

M4 退出条件（锁 R01 增补的 §11 M4 行）：① 两条既有 `M4|` 行全绿；② R01 新加的每一条 `M4|` 行全绿，含门 23–26 的四条整门；③ 在 M4 最终 head 上把全部 `M2|` 与 `M3|` 行重跑一遍且全绿；④ 合并后由 owner 在 staging 做一次真实投递、outbox 留下一行（`post-merge|23|staging真投递`，不挡合并前判定）。合并照锁 §14-5 另需独立合并授权。

### 6.2 剩余开发

- **M5 路由**：PR-4a（重复 / 字段等实体扩展）、PR-4b（附件）、PR-4c（投影）；依赖、里程碑与导出的归属以三者的设计为准（任务 E 设计 §3、§6、§7；验证 §5）；各自的路由表、开关与作业编排以三者的设计为准，本文不预写；三者都在 M4 合并授权之后起 Draft（S32 第二句，2026-10-09）；起草序未裁，本文建议 PR-4a 先起。
- **M5 前端**：FE-d 详情（重复 / 里程碑 / 依赖 / 字段值 / 附件）、FE-e 清单页（字段绑定、开启投影、深链、导出）、FE-f 多维表工作台拦截（走 `multitable-web-guard`）。
- **M5 退出**（S31）：五条既有 `M5|` 行；M5 候选门的编号待 R01 落锁后定；最终 head 上回归 M2 / M3 / M4 的全部行；合并后的 staging 验证由 owner 另行点名。
- **收尾项**：任务 D 的 `buildTaskByIdCondition` 已由 PR-3a 落地；`task-notifications.ts` 的 `attachment_added` 与 `task-ids.ts` 的 `tfld` / `tatt` 分别归 PR-4b S5 与 PR-4a S0；M3 评论分页与 M4 分页两套规则是否合流（PR-3a §12-Q8）。

---

## 7. 待 owner 的问题（按 PR、按编号；各自文档里附缺省值）

| 文件 | 编号 |
|---|---|
| 锁 / #6248 | 亲写确认评论；五句陈旧「§12 仍 PROPOSED」是否勘误；`i-m4` 块何时、由哪个 PR 写进锁（PR-3a §12-Q1）；PR 正文「起草方设计（需要 owner 确认）」13 处；PR 正文「需要 owner 回答」：M4 行的 ③ ④ 是否也适用于 M5（2026-10-09 的 S31 已定 M5 退出条件，见 §6.2，可在 PR 上注明） |
| M3 后端（已合并）设计 §3.7 末、验证 §20 | `TASK_BUSY`：软删行锁语句限时 3 秒是否改 1 秒；客户端是否须退避重试 |
| PR-3a 设计 §12 | Q2（改期时 `remind_at`）、Q3 的三处自选（码名、操作者豁免、转让目标校验）、Q4（N1 归哪个 PR，PR-3b 已按建议落实）、Q5（基分支）、Q6 的一处拆法、Q7（分组细则）、Q8(b)（两套分页是否合流）、Q9（`task_lists` 不建 `owner_id`、`icon` 建而不接）、Q10（合并后 staging 二选一及三问）、Q11（Draft 迁移口径与 `remind_at` 索引谓词）、Q12（`badgeScope` 键的出现规则）、Q13（日期写入两条严格规则、`description` 上限）、Q15（#6186 的处置）、Q17（所有者离开 org 的清单） |
| PR-3b 设计 §13 | Q2（投递保证形状、是否加状态机触发器）、Q3（关闭语义与 24 小时新鲜度）、Q4（汇总迟到上限）、Q5（汇总在发送时计算）、Q6（文案不带 deep link）、Q7（`outcome_unknown` 人工核对路径）、Q8（staging 真投递由哪个 PR 改 runner）、Q9（三开关以 `TASKS_ENABLED` 为前提、投递由本 tick 的 leader 跑）、Q10（落锁）、Q12（基分支）、Q13（钉钉集成所在 org）、Q14（`buildTaskByIdAnyStateCondition`）、Q15（集成停用时 skipped）、Q16（逐行标签）、Q17（claim 索引建议）、Q18（出站白名单）、Q19（manifest 是否带规则）、Q20（配置只取集成行）、Q22（加人致重启的新负责人是否收通知）、Q23（自管重启翻转是否通知）、Q24（R06 按处理时刻还是按 `remind_at` 时刻） |
| PR-3c 设计 §11 | Q2（不改变谓词输入的模式切换是否发）、Q3（只改时区是否收窄）、Q4（设置变更是否给本人房间发）、Q6（最终 head 的重跑由谁何时做）、Q7（多 org 用户的多余重拉是否接受） |
| M4 前端设计 §12 | Q1–Q4、Q6–Q11、Q13、Q14、Q16–Q35（Q5、Q15 已裁；Q12 前提不成立）；另有验证记录「闸审之后的修复」§7 的三项（409 后自动填入的浏览器时区是否算本人改动；重拉后草稿过不了日期预检；只经清单可见者移出最后一个清单后的落点）待 owner 定 |
| 任务 E 设计 §7 | 问题 1（改当前实例截止日或规则后，后续各期的锚点）、问题 2（CSV 的 dateTime 时区）、问题 3（重复 `count` 越界的码）；偏离 7、17、18、20 与每任务附件上限的计数口径是在已裁文字之上的读法，待逐条表态；D 编号未被模板点名 |
| 任务 D 设计 §5 | 标「own choice」的 7 行自选 |
| runner #6278 验证 §6 | `staging-tasks-smoke.test.mjs` 是否进 PR 门禁；是否保留 `MEMBER_TOKEN` 用例；outsider 令牌权限；清理助手真库测试是否在 CI 启用 |
| M5 | S31 候选门行入锁与编号；PR-4a / 4b / 4c 起 Draft 的点名（M4 合并授权之后） |

---

## 8. 文档索引

**`main` 上**

- 锁：`docs/development/task-feature-design-lock-20260917.md`；普查：`task-feature-census-20260917.md`；M0 报告：`task-feature-m0-development-20260917.md`
- 任务 B：`task-b-pure-functions-design-20260926.md` / `-verification-20260926.md`
- 任务 C：`task-c-m3-pure-functions-design-20260928.md` / `-verification-20260928.md`
- M2：`task-feature-m2-design-verification-20260927.md`、`task-m2-backend-design-20260927.md` / `-verification-20260927.md`、`task-m2-frontend-design-20260927.md` / `-verification-20260927.md`
- M3：`task-m3-backend-design-20260928.md` / `-verification-20260930.md`、`task-m3-frontend-design-20260928.md` / `-verification-20260929.md`

**Draft 分支上**（以 `分支:路径` 读取）

- 任务 D（#6186，`630e85ead8`）：`claude/tasks-d-pure:docs/development/task-d-m4-pure-functions-design-20260930.md` / `-verification-20260930.md`
- 锁 R01 增补（#6248，`69a7c08f8f`）：`claude/tasks-lock-r01:docs/development/task-feature-design-lock-20260917.md`（相对 `main` 只改抬头、§11、§12）
- M4 PR-3a（#6266，`68e40323bd`）：`claude/tasks-m4-pr3a:docs/development/task-m4-pr3a-backend-design-20260930.md` / `-verification-20260930.md`
- M4 PR-3b（#6281，`2974ba5363`，绿线 head `4837f1ffdd`）：`claude/tasks-m4-pr3b:docs/development/task-m4-pr3b-backend-design-20261001.md` / `-verification-20261001.md`
- M4 PR-3c（#6269，`3edd133ae0`）：`claude/tasks-m4-pr3c:docs/development/task-m4-pr3c-backend-design-20261008.md` / `-verification-20261008.md`
- M4 前端（#6265，`5e73a6b8f3`）：`claude/tasks-m4-frontend:docs/development/task-m4-frontend-design-20261007.md` / `-verification-20261007.md`
- 任务 E（#6249，`d6c84264ff`）：`claude/tasks-e-pure:docs/development/task-e-m5-pure-functions-design-20261007.md` / `-verification-20261007.md`
- runner 冒烟（#6278，`c980f78015`）：`claude/runner-smoke-from-tarball:docs/development/staging-runner-smoke-bundle-design-20261007.md` / `-verification-20261007.md`

**本文未核实、只按各记录转述的项**：各 Draft 分支记录里的本地命令结果与变异表（本文没有重跑）；PostgreSQL 16.15 上的运行只按 PR-3b、PR-3c 与 runner 的验证记录转述；staging run 编号按当时记录。
