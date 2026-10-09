# 任务功能线 — 总体设计与验证（2026-10-09）

- 日期：2026-10-09。状态：**汇总记录**。本文只汇总已在 `main` 或 Draft 分支上的设计与验证记录（含 §4.6 所记、本文写成时尚未推送的修订），不构成合并授权、DDL 应用授权或任何 `TASKS_*` 开关的授权，也不改动锁（`docs/development/task-feature-design-lock-20260917.md`）的任何条款。
- 基线：`origin/main` @ `64bf18b5e8`（#6250，2026-10-09 取）。2026-10-09 同日更新一次：`origin/main` 已到 `fab1313489`（#6282）；M4 后端三张 Draft 当日重建在 `main` `8f90307d5a` 上（§4.5）。2026-10-10 再读：`origin/main` 在 `80cb873225`（#6288），`fab1313489` 之后的六个提交都没有新增迁移（§6.1）。各 Draft 的 head 记在 §1.3 与 §8，检查状态记在 §4.2（gh 读数，时刻写在表前）。本文日期与时刻一律按 UTC+8。
- 2026-10-09 晚再更新一次：owner 当日对此前列在 §7 的六项作了裁定，本文把它们写成规则（§3 登记、§7.1 逐项）；当晚各分支按裁定与一条审阅发现所做的修订记在 §4.6。2026-10-10 再更新一次：§4.6 的四项修订（锁、PR-3c、前端、任务 E）都已定稿，本文改引各自的定稿提交；这一版写成时四者都没有推送，gh 上各 PR 的 head 仍是 §4.2 所列。
- 对标：飞书「任务」。范围按锁 §0–§3 的裁决，见 §1。
- 引用口径：锁与各里程碑的设计 / 验证记录按仓库路径引用；只在 Draft 分支上的文档以 `分支名:路径` 引用；PR 以编号引用；owner 裁决只写条目编号与日期。裁决包与裁决书不在仓库内，本文不转述其原文。
- 本文是 2026-10-01 开发目标里总体设计与验证 MD 一项的交付；每个 PR 自己的设计与验证记录仍以各分支内的文件为准，本文不代替它们。

---

## 0. 结论摘要

1. **已落 `main`**：M0 普查与锁（#5845）、M1 裁决（2026-09-26）、任务 B 纯函数（#6086、#6102）、M2 后端（#6062）与前端（#6092）、任务 C 纯函数（#6123）、前端门禁 R-28（#6173）、staging runner 三件（#6158、#6167、#6177）、M3 后端（#6229）与前端（#6159）、冒烟随 runner 打包（#6278，2026-10-09）。锁正文 §0–§11、§13–§15 于 2026-09-26 ratify，§12 门表于 2026-09-28 ratify（PR #5845 评论 5871552862）。
2. **staging**：运行 `main` `7137688372` 的镜像，`TASKS_ENABLED=true`，M2 与 M3 的迁移已应用（含 `task_comments`）；2026-10-09 #6278 合并后在 staging 跑 `smoke=tasks`（run 37888015811，覆盖 M2 与 M3 路由）：99 条断言通过、残留 0（§4.4）；生产未动；三个 P1 开关在任何环境都未打开。
3. **Draft，未合并**：任务 D（#6186）、锁 R01 增补（#6248）、M4 PR-3a（#6266，2026-10-09 重建为 `main` 上的单提交）、M4 PR-3b（#6281）与 PR-3c（#6269，各为叠在 #6266 之上的单提交）、M4 前端（#6265）、任务 E（#6249）。#6126（M3 HTTP 契约文档）仍是开着的 Draft，实现已由 #6229 落 `main`，处置待 owner 点名（§6.1）。M4 的合并流程（§6.1）：按 2026-10-09 裁定修订的锁推送到 #6248，owner 在 #6248 上亲写确认评论并点名合并 #6248 → 在合并前的最终候选集成树上做 R01 ①–③ 的判定并留下记录 → owner 逐张点名 #6266、#6281、#6269、#6265。R01 只有 ④（staging 真投递一次）在合并之后。锁、PR-3c、前端与任务 E 当晚各有一版修订，都已定稿，本文写成时都未推送（§4.6）。
4. **未开始**：M5 的路由 PR-4a / 4b / 4c 与前端 FE-d / e / f，按 2026-10-09 的裁决在 M4 合并授权之后才起 Draft；起草方式与锁 §2 承重两项、任务内历史的交付位置同日裁定（§6.2）。
5. **验证面**：每个 PR 都有独立多视角闸审（每条发现三票反驳）、单测、真库 lane（本地 PostgreSQL 15.17；PR-3a、PR-3b、PR-3c 的 lane 与鉴权门另在另一台机器的 PostgreSQL 16.15 上跑过；2026-10-09 CI 的 `tasks-realdb`（postgres:16）在三张重建后的 head 上各跑过一次，见 §4.2、§5）、专属鉴权门、源码变异证明；M3 后端另有合并前对 `main` 的合并预演与 staging 部署 + 冒烟。2026-10-09 的合并预演、各 PR 当日的改动、重建与守卫加强见 §4.5，当晚的修订见 §4.6。未跑的项目逐条列在 §5。
6. **owner 2026-10-09 裁定的六项**：门 26 的信号窗口与锁内五句状态句的勘误、门 15 的读法、锁 §2 承重两项的归属、PR-3a §12-Q10、任务内历史与跨任务动态、M5 的起草方式。规则见 §7.1，登记见 §3；它们都不是合并、DDL 执行或开关的授权。

---

## 1. 范围与对标

### 1.1 对标结论（锁 §0、§2、§3）

飞书「任务」分三层：任务实体、任务清单、IM 原生层。本线对标**实体层**全部承重机制（锁 §2 第 1 条中的已完成 / 全部视图与第 3 条中的创建人为所有负责人完成，此前没有落到里程碑；owner 2026-10-09 裁定二者仍是承诺，并定了交付位置，见下表与 §6.2），清单层按 P1 / P2 分期做实体与投影，IM 原生层不对标。承重机制（锁 §2）：四种角色视角 + 已完成 + 全部；多负责人与全部 / 任一完成；创建人完成的范围与重启的 `scope`；子任务含根五层；创建人默认为负责人且可移除、零负责人合法；截止日期与具体时间点、提醒缺省 −30 分钟 / 当天 18:00；红点三种口径；关注人只读 + 评论 + 退出；清单归档不改变任务可见性；可见不等于等我处理。

| 模块 | 裁决 | 期次 | 状态 |
|---|---|---|---|
| 任务实体 / org / 五视角 / 完成重启 / pending / 前端 `/tasks` `/tasks/:id` / 红点 / 缺组织引导 | 做 | P0-A / M2 | 已合并 |
| 子任务树 / 评论 / 成员 / 完成模式 / 软删 | 做 | P0-B / M3 | 已合并 |
| 清单 / 分组 / 设置 / 日期写入与 PATCH / 分页 / 提醒 outbox / 事件通知 / 调度 / 钉钉通道 / 红点实时失效 | 做 | P1 / M4 | Draft |
| 重复任务 / 附件 / 里程碑与依赖 / 投影 + 交互 / 自定义字段 / 清单导出 | 做 | P2 / M5 | 纯函数 Draft；路由未开始 |
| 创建人为所有负责人完成（锁 §2 第 3 条） | 做（owner 2026-10-09 裁定） | M5，PR-4a 的第一片 | 未开始 |
| 已完成 / 全部视图与默认只看未完成（锁 §2 第 1 条）的状态筛选核心 | 做（owner 2026-10-09 裁定） | M4 之后单独交付，先于 FE-e；排序与字段显隐另列 | 未开始 |
| 任务内历史 | 做（owner 2026-10-09 裁定） | M5 之后单独交付 | 未开始 |
| 跨任务动态页 | 后置（锁 §13-34；owner 2026-10-09 裁定继续后置） | — | — |
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
| 任务 D | 无 I/O 纯函数（清单、分组、提醒、通知、设置、分页、实时） | #6186 | Draft；拟按被 #6266 取代关闭（PR-3a §12-Q15） | `224eb7b96f` |
| 锁 R01 增补 | §11 M4 行拆写、§12 门 23–26 与 `arm-set` 子集行 | #6248 | Draft；按 2026-10-09 裁定的修订已定稿、未推送（§4.6） | `126e9bd182`；定稿为其上两个提交，最新 `95794d2c23`，推送前 #6248 的 head 是 `126e9bd182` |
| M4 PR-3a | 一条迁移（8 张 P1 表 + `tasks.remind_at`）、清单 / 成员 / 清单项 / 分组 / 设置路由、日期写入与 PATCH、分页、R04、R17 / N2 | #6266 | Draft；2026-10-09 重建 | `7338f52e11`（`main` `8f90307d5a` 上的单提交） |
| M4 PR-3b | outbox producer、调度器、投递 worker、钉钉通道、N1、三个开关 | #6281（Draft，base `claude/tasks-m4-pr3a`） | Draft；S0–S7 与再门审修复（S-gate2）完成，2026-10-09 改叠并随 PR-3a 重建 | `9c2f7ab487`（单提交，父提交为 #6266 的 `7338f52e11`） |
| M4 PR-3c | 红点实时失效（socket 扇出） | #6269（base = PR-3a 分支） | Draft；2026-10-09 随 PR-3a 重建；当晚按审阅发现改记固定码，再次重建并定稿（§4.6） | `b801bd53da`（单提交，父提交为 `7338f52e11`）；定稿为同一父提交上的单提交 `4e58af6a7b`，推送前 #6269 的 head 是 `b801bd53da` |
| M4 前端 | 设置页、详情编辑、清单、成员、分组板、i18n、实时订阅 | #6265 | Draft；当晚加了门 26 窗口的逐条格，并按锁定稿列出的七个格名定名，已定稿（§4.6） | `0a4dfd6ee9`；定稿为其上六个提交，最新 `734ef4c3af`，推送前 #6265 的 head 是 `0a4dfd6ee9` |
| 任务 E | 无 I/O 纯函数（民用日期 / 依赖 / 里程碑 / 重复 / 字段 / 附件 / 投影 / 导出） | #6249 | Draft；当晚只改文档的修订已定稿、未推送（§4.6） | `3ac4a7ebc5`；定稿为 `7137688372` 上的单提交 `39a2a29be9`，推送前 #6249 的 head 是 `3ac4a7ebc5` |
| M5 路由与前端 | PR-4a 实体扩展、PR-4b 附件、PR-4c 投影；FE-d / e / f | — | 未开始；起草方式 2026-10-09 已裁（§6.2） | — |
| staging 冒烟 | 冒烟脚本随 runner 打包、补 M3 用例 | #6278 | 已合并 2026-10-09 | `fc139c868e` |

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
| P1（M4，PR-3a #6266） | `zzzz20261009130000_create_task_m4_tables.ts`（一个文件；头注写明 Draft 迁移、不从本 PR 应用；2026-10-09 由 `zzzz20261008090000_…` 重新定名，§4.5） | `task_lists`（自带 `org_id`，单点发射）、`task_list_members`（复合主键；`owner` 唯一；`created_by` 永为成员）、`task_list_items`（复合主键；`org_id` 列与两条组合外键，任务与清单必须同 org）、`task_groups` / `task_group_items`（scope `list` / `user`；每 scope 恰一个默认组）、`task_list_events`（15 词闭集）、`task_user_settings`（PK `(user_id, org_id)`；`badge_scope` 三值、`daily_reminder_enabled`、`default_remind_policy` jsonb、`time_zone` 与 CHECK「开每日提醒必须有时区」）、`task_notification_deliveries`（outbox：`org_id` 非空无默认值；`status` 七值含 `outcome_unknown`；`recipient_role` 四值；唯一键 `(org_id, source_key)` 与三条非唯一索引）；`tasks.remind_at` 与部分索引；`idx_tski_task` |
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

- 事件名 `tasks:counts-updated`；房间 `auth-user:<userId>`（socket 在令牌验证后由服务端加入，客户端不发 join）；载荷恒为 `{}`，不含计数与任务字段；收件人 = 本次写入前后负责人集合的并集，关注人不收；只在写入事务提交之后发送，回滚零发送；发送失败只记一条 `warn`，不重试、不进 outbox。日志只有固定说明与固定码 `TASK_COUNTS_SEND_FAILED`，此外什么都不记，也不从错误对象读任何东西：错误的 message、stack、`code` 与类名都可能带上取值，读属性本身也可能抛出。错误与日志只带码、不带取值，是这一件必须满足的规则，不是可选的加固（PR-3c 设计 §4.3 修订 7、记录 §12.2，定稿 `4e58af6a7b`）。推送前 #6269 上的 `b801bd53da` 仍从错误自带的 `code` 或类名取码，这一写法由当晚的审阅发现改掉（§4.6）。
- 触点由谓词而不是枚举决定：写入提交之后，若 `buildTaskPendingCondition` 读到的某个输入变了——`task_assignees` 的行集合、每位负责人的 `completed_at`、`tasks.status`、`tasks.deleted_at`、截止四列或 `time_zone`——就发一次；对应八个服务函数：`createTask`、`completeTask`、`reopenTask`、`addAssignee`、`removeAssignee`、`switchCompletionMode`、`deleteTaskById`、`patchTask`（动到截止字段或时区时）。单测里有一格把写入者普查钉在源码上，新增写入者而不接信号即红。
- 接线在 `MetaSheetServer` 构造函数里经服务器自己的 websocket API 转到 `CollabService.broadcastTo`；socket 服务是进程内 adapter，多进程部署下其余客户端等下一次轮询。
- 前端（FE-c）：`useTasksCountsRealtime` 订阅该事件，红点（`useTasksBadge.ts`）把信号按固定 500 ms 的窗口合并后重拉 `/pending-count`（带查看者时区头）。窗口规则（门 26，owner 2026-10-09 裁定）：没有窗口开着时，一条信号打开窗口，窗口从这条信号起计 500 ms，后到的信号不让它顺延，到点读一次；窗口开着时新开始的一次读取（总线 nudge 或轮询）晚于窗口里的每条信号，算作提前回答了它们，窗口随即关闭、到点的读取取消（隐藏页里跳过读取的轮询 tick 没有开始读取，不算）；读取开始以后才到的信号另开一个窗口；信号到达时已经在途的读取不回答它，这次读取返回时窗口不关闭，到点照常读。前端代码本来就这样工作；当晚加了逐条钉住这些规则的格，并与原有的两格一起按锁定稿列出的七个格名定名，两个生产文件只改注释（§4.6）。60 秒轮询保留且是必需的另一半；feature 关闭或退出登录时红点卸载即断开；没有令牌或已拆除时不建连接、不留任何状态，之后带令牌的 `reconnect()` 照常建连（2026-10-09）。

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
- M4 迁移的部署耦合（PR-3a §9.2、§12-Q10）：PR-3a 之后 M2 / M3 的任务路由在角色解析时读 `task_list_items` / `task_list_members`，`/pending-count` 读 `task_user_settings`；凡 `TASKS_ENABLED='true'` 并运行这份代码的环境必须已应用 M4 迁移。合并后 staging 的共享 `deploy` 动作会在换上新镜像之后、于迁移对齐门处失败，直到 M4 迁移在 staging 应用。
  - PR-3a §12-Q10 的二选一，owner 2026-10-09 裁定取 (i)：staging 迁移经 owner 授权之后执行；这项裁定本身不是执行授权。时点按 PR-3a §9.2：#6266 合并之后、staging 部署含这份代码的镜像之前。
  - 执行前先按目标 SHA 列出完整的 pending 迁移集合；#6264、#6282 带来的迁移届时若仍未在 staging 应用，也在其中。A-3 继续排除。顺序是先备份并做克隆演练，再 `action=migrate`、`action=deploy`、冒烟。
  - 未采用的 (ii) 是把该迁移列入 owner 排除清单并保持 `tasks_enabled=false`；它要先合一张改共享 runner 的 PR，因为排除清单是 runner 脚本里的代码常量，runner 工作流没有对应的输入。
  - PR-3a 分支上的冒烟脚本在写任何种子行之前先查三张 M4 表，缺哪张就按表名失败（2026-10-09 移植到 #6278 改写后的脚本与 harness）。
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
| 2026-10-07 | runner PR | 冒烟脚本随 runner 打包、补 M3 冒烟用例；审阅 0 P1 / P2 且必需检查全绿后合并 | 未登记（owner 2026-10-07；#6278 的正文、评论与审阅里都没有）；#6278 于 2026-10-09 合并 |
| 2026-10-07 | 直接角色规则 | 增删负责人与关注人只认创建人或负责人；清单派生编辑者保留 PATCH、设父、完成 / 重启、切模式、评论 | PR-3a 设计 §3.4、§6.3（`[own-53]`） |
| 2026-10-09 | S01–S37 | M5 裁决包按推荐值落槌；PR-4a / 4b / 4c 在 M4 合并授权后起 Draft（S32 第二句） | 任务 E 设计抬头、§9 |
| 2026-10-09 | 通知正文冒号 | 通知正文里的用户文本把半角冒号渲染为全角冒号 | PR-3b 设计 §8.3 |
| 2026-10-09 | 门 20 变严 | harness 增加从语法树读取的静态导入检查 | 任务 E 设计 §7 问题 4、§9 |
| 2026-10-09 | 门 26 信号窗口 | 前端重拉以固定 500 ms 的窗口合并信号；窗口开着时开始的一次读取可提前回答已到的信号；读取开始以后才到的信号开一个新窗口；已发出未返回的读取不回答新到的信号 | 锁 §12 门 26（定稿 `95794d2c23`，带「owner 2026-10-09 裁定」括注）；M4 前端验证记录「2026-10-09 门 26 前端格按格名」一节（`734ef4c3af`）；两者本文写成时都未推送（§4.6），锁抬头所写的确认出处待 owner 在 #6248 上亲写评论 |
| 2026-10-09 | §12 状态句勘误 | 锁内五句仍称 §12 门表 PROPOSED 的状态句改为 2026-09-28 已 ratify，原 ratify 依据（评论 5871552862）不变 | 锁抬头「§12 增补」一条（定稿 `95794d2c23`，本文写成时未推送，§4.6）；确认出处待 owner 在 #6248 上亲写评论（owner 2026-10-09） |
| 2026-10-09 | 门 15 读法 | 看注释是否点名其他线的具体符号；钉钉这个品牌名与本任务通道自身的常量、错误码不算；逐行归类的证据留着，也不按整个文件豁免 | 各 PR 与记录里尚无登记（owner 2026-10-09）；#6281 的逐行证据在 PR-3b 记录 §1009b.3 |
| 2026-10-09 | 锁 §2 承重两项 | 二者仍是承诺：创建人为所有负责人完成放进 PR-4a 的第一片、排在重复任务的派生之前；状态筛选核心在 M4 之后单独交付、排在 FE-e 之前；排序与字段显隐另列 | 各 PR 与记录里尚无登记（owner 2026-10-09）；本文 §6.2 |
| 2026-10-09 | PR-3a §12-Q10 | 取 (i)：staging 迁移经授权后执行，事先按目标 SHA 列出完整 pending 集合、A-3 排除、先备份与克隆演练 | 各 PR 与记录里尚无登记（owner 2026-10-09）；本文 §2.9 |
| 2026-10-09 | 历史与动态 | 任务内历史在 M5 之后单独补齐；跨任务的动态页仍然后置；历史接口不把事件 payload 原样交出 | 各 PR 与记录里尚无登记（owner 2026-10-09）；本文 §6.2 |
| 2026-10-09 | M5 起草方式 | 受控的堆叠起草；合并按依赖关系逐张串行；PR-4a 的表结构与接口先冻结 | 各 PR 与记录里尚无登记（owner 2026-10-09）；本文 §6.2 |

**尚未裁 / 尚未发生**：按 2026-10-09 裁定定稿的锁修订（`95794d2c23`）推送到 #6248；其后 #6248 的 owner 亲写确认评论（锁 §14-2）与锁抬头的评论 id 回填；#6248 的合并点名；R01 ①–③ 在合并前的最终候选集成树上的判定记录（§6.1）；其后 #6266、#6281、#6269、#6265 的逐张合并点名；#6266 合并后 staging 迁移的执行授权（§2.9）；任何 M5 PR 的合并点名；`tasks-realdb` 追加进 `main` 必需检查（合并后的 owner 步骤）；各 PR 其余的 owner 问题（§7.2）。2026-10-09 PR-3a 迁移的重新定名按 PR-3a 自己的合并前规则做，不是 owner 裁决，不入本表。

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
| #6278 runner 冒烟（2026-10-09 合并） | runner 自检 385（pipeline 198 + 任务冒烟 harness 187，含 149 个错形回答子测试）；清理助手 19（真库 19 / 19） | 清理助手在真实 PostgreSQL 上按四个冒烟范围验证（事务内回滚） | — | 全断言扫描 195 杀 194（1 等价）；具名 34；闭包扫描规则 15 处删除各被抓；第二轮 202 杀 201；第四轮拒绝规则 8 个与 no-git 钉 18 个全杀（1 个对照全绿）；第五轮 10 杀 9（1 存活为环境变量旁路，已记） | 5 轮复审：首轮无级别标注；第二轮 1 P2（清理按 API 回答 id 删行）；第三轮 1 P1（清理助手用户前缀过滤的 SQL 参数类型）+ 1 P2（harness 不核对目标 id）+ 1 P3 + 3 NIT；第四轮 1 P2（考勤三冒烟改为拒跑）+ 5 P3 + 3 NIT；第五轮 1 P2（`smoke` 默认值未钉）+ 7 P3 / NIT；未改代码的 P3 / NIT 列在 PR 正文 | 本地端到端对真实后端多次 PASS 99 断言（前几轮 PG 15.17，第四轮在另一台机器的 PG 16.15、未在 15 上重跑），代理改写外部 id 的两次按设计失败且外部行不变；条件合并授权见 §3（PR 上无登记）；head `c980f78015` 的 13 项必需检查全绿后于 2026-10-09 合并为 `fc139c868e`；合并后 staging `smoke=tasks` 通过（run 37888015811，§4.4） |

### 4.2 Draft（未合并）

检查状态是 2026-10-09 19:14 的 gh 读数（各 PR 当时的 head）。「cancelled」是作业被取消，不是测试结论。表里只有当时已推送的 head；当晚的修订在本文写成时未推送、没有 CI 结果，见 §4.6。

| PR | 单测 / 类型 | 真库 lane | 鉴权门 | 变异 | 独立闸审 | CI / 其他 |
|---|---|---|---|---|---|---|
| #6186 任务 D | 任务单测 22 文件 684 格，第四轮后 689 格；全量 17999 / 0 失败；两条 CI `tsc` 命令零输出；eslint 零新增 | — | — | 28 处（9 手工 + 19 脚本化，还原后 `git diff` 哈希一致）+ 第四轮 5 处，全部变红 | 4 轮独立复核（第 3 轮 13 项含两处实测确认的真缺陷：`offset: 1e300` 静默通过、`2026-02-30` 静默滚动；第 4 轮 6 项 0 P1） | head `224eb7b96f`（2026-10-09 只改两份文档）：13 项必需检查全绿；共 26 项，20 success、5 项非必需检查以 cancelled 结束、1 skipped |
| #6248 锁 R01 增补 | 锁内两条自检（`arm-set` 键不重复、门号 1–26；R01 涉及的 18 行逐字存在）exit 0，负控（删 `M4\|23\|整门` 或 `M4\|19\|清单角色`）exit 1；2026-10-09 的第二个提交只改门 26 那一行，两条自检在新 head 上重跑输出不变（PR 正文） | — | — | — | —；PR 正文列 14 处「起草方设计（需要 owner 确认）」（第 5 条是 2026-10-09 加入的门 26 前端重拉按信号窗口计；这一条与五句状态句的勘误当晚已裁，§3）与 1 项「需要 owner 回答」（§7.2） | head `126e9bd182`：21 项检查全部 success（含 13 项必需）；抬头评论 id 占位待 owner 亲写确认后回填；按裁定的修订见 §4.6 |
| #6266 M4 PR-3a | 任务单测 29 文件 1160 格；全量 20445（本机 5 个文件因环境失败，与本 PR 无关）；`tsc` 0；2026-10-09 重建后：`tsc` 0、任务单测 29 文件 1160 格、迁移守卫三件 36 格、`staging-tasks-smoke` 191 / 191、flag manifest 38 / 38、鉴权门接线 3 / 3（记录 §1009r.4） | 16 文件 708 格 ×3（PG 15.17）：`task-m4-schema` 59、`-list-roles` 50（含 `gate19m4` 25 格）、`-paging-settings` 77、`-dates` 107、`-lists` 66、`-list-members` 44、`-list-items` 25、`-groups` 38、`-org-members` 46 + M2 / M3 七文件 93 + 103；2026-10-09 另一台机器 PostgreSQL 16.15 上，重新定名后与重建后各一遍 708 / 708（记录 §1009.3、§1009r.4）；CI `tasks-realdb`（postgres:16，run 37919022462）16 文件 708 passed | 86 格（P0-A 8 条 + M3 13 条 + M4 30 条路由的门 1 / 门 2 / 门 16，路由人口 51 有负控；清单第二租户读格在 trust-off 下）；PostgreSQL 16.15 上 86 / 86 | 手工 458（457 红、1 等价）；文件内负控（门 1 / 8 / 13 / 19 与负控 1–7）每遍 lane 或鉴权门都跑；2026-10-09 把 manifest `purpose` 改回旧迁移名时 36 格中 1 格变红（§1009.1） | S1–S3 + S4 闸、S5 + 修复切片闸（7 条：0 P1、1 P2、4 P3、2 NIT）、S6 + S7 闸（9 条 8 成立，处置见记录 §S67F.1）、S8–S10 增量闸（3 P2 + 14 P3 / NIT）；每轮有修复切片，最后一轮修复本身未再过闸 | 迁移在一次性库 `up → down → up` 与 `search_path` 置空的 `pg_restore` 核过；2026-10-09 在 PostgreSQL 16.15 上核过 `--rollback` 只回退本迁移（§4.5）；head `7338f52e11`（`main` `8f90307d5a` 上的单提交）：13 项必需检查 12 项 success、`test (20.x)` 运行中（其后 gh 再读：`test (20.x)` 于 19:41 以 success 结束，13 项必需检查全绿）；`tasks-realdb`、`migration-replay`（run 37919022410）、`migration-prod-image-parity (postgres:15-alpine)`（run 37919022386）success；另 11 项非必需检查以 cancelled 结束 |
| #6281 M4 PR-3b | 任务线单测 38 文件 1519 格（S7 时 1503）；全量 19024 passed（失败的是记录里同一组 5 个与本线无关的文件）；manifest 39 / 39、102 / 102；`tsc` 0；2026-10-09 改叠后 39 文件 1539 格（含迁移前缀唯一守卫 20 格），重建后 38 文件 1519 格、迁移守卫 36 格、manifest 41 / 41、`staging-tasks-smoke` 191 / 191（记录 §1009b.4、§1009m.5） | 20 文件 795 ×3（另一台机器 PostgreSQL 16.15，记录 §S-gate2.4；新文件 `task-m4-outbox` 21、`-delivery` 30、`-scheduler` 25、`-dingtalk` 11）；2026-10-09 改叠后与重建后各一遍 795 / 795；CI `tasks-realdb`（postgres:16，run 37919030353）20 文件 795 passed | 86 | 不同 mutant 310（S0 13、S1 62、S2 35、S3 15、S4 42、S5 47、S6 32、门审修复 42、再门审修复 22），309 红、1 等价；执行 367 次（记录 总览.3）；2026-10-09 records 守卫加强的 12 个变异全部变红（§1009m.3） | 设计评审 34 条（33 采纳、1 部分采纳）；S2–S6 门审 6 项确认 + 14 行 P3 / NIT 全处置（停机退还、leader 会话界限与心跳、钉钉分类负控、floor 语句钉住、脱敏规则、措辞）；S7 之后的再门审 2 项确认 + 1 项未确认与 17 行 P3 / NIT：2 项全部处置，18 行里 15 行改正或加格、3 行记为已知限制（记录 总览.4）；其后的独立核验 0 P1 / 0 P2（PR 正文「再核验」） | head `9c2f7ab487`（叠在 `7338f52e11` 上的单提交）：以非 `main` 分支为基，没有必需检查；跑了的 39 项检查全部 success；`plugin-tests`、`web-tests`、contracts 与 `migration-replay` 不触发（记录 总览.5），13 项必需检查里有 6 项没有在它上面跑过（§5） |
| #6269 M4 PR-3c | 新单测 `task-counts-realtime` 17、`task-counts-touchpoints` 62（含写入者普查格与「提交后才发送」前提格）；任务子集 31 文件 1239；`tsc` 0；2026-10-09 第三轮后 `task-counts-realtime` 19 格、任务子集 31 文件 1241（记录 §12.4） | 首轮本地 PG 15.17：17 文件 727 ×3；闸修复后：17 文件 729 ×3 在另一台机器的 PostgreSQL 16.15（记录 §10.3；新文件 `task-m4-realtime` 21，`gate26\|` 前缀，候选）；2026-10-09 第二轮一遍 729；重建与第三轮第一遍 728 / 729（PR-3a 的 `task-m4-dates` 一格在机器高负载时超过 30 秒时限），第二遍 729 / 729，最终提交上另一遍 729 / 729（§11.2、§12.4、PR 正文）；CI `tasks-realdb`（postgres:16，run 37919036262）17 文件 729 passed | 86 | 37 全杀；闸修复后 32（31 杀、1 按设计存活）+ 真库 7 全杀；文件内负控甲 / 乙 / 丙 / 关注人与接线负控各有「控件的控件」；2026-10-09 第二轮 27 个（24 红、3 个对照按设计存活），第三轮日志变异 5 个各红其应红的格（§11.4、§12.5） | 闸审 14 条全处置（记录 §10.2）：1 P2（门 26 没有一格让操作者本身是负责人）、5 P3、8 NIT；闸审另做了随机写入对拍、并发写入与真实 socket 连接的核对（PR 正文） | R01 ③ 的预备：在 PR-3a + PR-3c 的 head 上把锁 `M2\|` 27 行、`M3\|` 2 行逐行重跑并记控件（验证记录 §6），不代替合并前的判定（§12.3）；head `b801bd53da`（叠在 `7338f52e11` 上的单提交）：没有必需检查；跑了的 39 项检查全部 success；与 #6281 同样，13 项必需检查里有 6 项没有在它上面跑过；当晚改记固定码的重建见 §4.6 |
| #6265 M4 前端 | 24 个 whole-file spec 1933 格；`vue-tsc` 0；必需 web lane 本地全跑；D = T = G = 23；2026-10-09 修复轮后守卫 24 文件 1934 格、必需 web lane 634 文件 12418 格、token 清单 560 `MANIFEST MATCHES`（验证记录「2026-10-09 修复轮」） | — | — | 599（595 红、4 等价）；加 2026-10-09 修复轮共 600（596 红、4 等价） | 设计评审 27 条全处置、无驳回（设计 §15）；实现闸审 8 P2 + 1 未确认项 + 18 P3 / NIT 全处置（验证记录「闸审之后的修复」） | 推送前按 head 的树把提交历史重建为单个提交；真机走查一次（Chromium、中文、PR-3a 后端 `f4a0eb532c` + 一次性库）11 步都得到预期结果，顺手发现并修了写后焦点丢失（`[fe-48]`）；head `0a4dfd6ee9`：13 项必需检查全绿，`tasks-web-guard` success；共 26 项，22 success、3 项非必需检查以 cancelled 结束、1 skipped；当晚在其上加的门 26 窗口格见 §4.6 |
| #6249 任务 E | 任务单测 30 文件 958 格（另按三个进程时区各跑一遍）；门 20 35 / 35；`'x'` 探针与 import 图 44 / 44；全量 20199 / 20243（5 个已知环境失败文件）；两条 `tsc` 零输出；eslint 零问题；2026-10-09 文档修订后三种进程时区下仍是 30 文件 958 格（PR 正文） | — | — | 76 / 76 在最终代码重跑；复审后新守卫 77 / 77 | 闸审 0 P1（PR 正文）、10 P2（验证 §7.1）+ 22 P3 / NIT，全部处置（其中 3 条推送时的动作在推送时完成，验证 §7.2） | head `3ac4a7ebc5`（2026-10-09 只改两份文档）：13 项必需检查全绿；共 26 项，21 success、4 项非必需检查以 cancelled 结束、1 skipped；当晚只改文档的定稿修订见 §4.6 |

### 4.3 门表计分状态

- M2 退出集合（锁 `arm-set` 的 `M2|` 行）于 2026-09-28 随 §12 ratify 计分（PR #5845 评论 5871552862）；`M3|3|增删人切模式` 与 `M3|6|整门` 由 #6229 的 `task-m3-membership` / `task-m3-tree` 承载。
- M4 行：锁里既有的 `M4|8|A支与非法IANA`、`M4|19|清单角色` 由 PR-3a 的 `task-m4-dates`（含运行期定极性的 A 支与两个生产码 mutant）与 `task-m4-list-roles`（`gate19m4` 25 格、`any_role` 清单臂 mutant）承载；R01 新加的子集行（`M4|1|清单第二租户`、`M4|2|清单路由`、`M4|8|提醒与每日汇总`、门 1 / 2 / 13 / 17 / 18 / 20 / 21 / 22 的新表面）与新门 23–26 的格分别落在 PR-3a、PR-3b、PR-3c、前端，在 #6248 合并之前一律候选、未计分；`i-m4` 块尚未写进锁（PR-3a §12-Q1）。
- M5 行（`M5|7`、`M5|9`、`M5|10|P2子集`、`M5|19|投影端`）首个可跑为 M5，NOT RUN；候选 M5-a…g 与门号取决于 R01 落锁（S31）。

### 4.4 staging 实跑

| 日期 | 动作 | 结果 |
|---|---|---|
| 2026-09-29 / 09-30 | 发布 `main` 镜像（run 36539328177，09-29）→ migrate（run 36604689198：备份、克隆演练、应用 11 条含任务两条，414 → 425，A-3 未应用）→ deploy `tasks_enabled=true`（run 36605301193）→ `smoke=tasks`（run 36605579996）；后三步在 09-30 | `TASKS_API_DB_SMOKE_PASS` 19 / 19：准入前 context 403、授予后 200；新建 / 视图 / 完成 / 重开 / 详情全 200；残留 0；考勤设置前后一致 |
| 2026-10-07 | 发布 `main` `7137688372`（run 37632249552）→ migrate（run 37633129605：425 → 430，含 `task_comments`；A-3 三个检查点仍排除）→ deploy `tasks_enabled=true`（run 37634034316）→ `smoke=tasks`（run 37634643293，部署机仓库同步跳过） | 19 / 19 PASS；staging = `7137688372` + `TASKS_ENABLED=true`；冒烟只覆盖 M2 路由，M3 路由的冒烟在 #6278（2026-10-09 已在 staging 执行，见下一行） |
| 2026-10-09 | #6278 合并（`fc139c868e`）后派发 `smoke=tasks`（run 37888015811，工作流取 `fc139c868e`，冒烟对在线的 `7137688372` 镜像；不重发布、不重部署） | 99 条断言 PASS，覆盖 M2 与 M3 路由（含评论的增改删读、父子任务删除与删除后 404、无关系的已准入用户 404）；残留 0（`TASKS_API_DB_SMOKE_PASS … residue=0`） |

回退规则：同 SHA 以 `tasks_enabled=false` 重部署；迁移已应用，不能回到旧镜像。

### 4.5 2026-10-09：合并预演、各 PR 当日的改动、重建与守卫加强

本节转述各 PR 的记录与正文，精度以它们为准。出处是各验证记录里 2026-10-09 的小节：PR-3a §1009 与 §1009r、PR-3b §1009b 与 §1009m、PR-3c §11 与 §12、前端「2026-10-09 修复轮」，以及任务 D、任务 E、锁 R01 当日的提交与 PR 正文。

1. **#6281 的再核验**：PR 正文「再核验」记有再门审修复（PR-3b 记录 S-gate2）之后的一轮独立核验，0 项 P1 / P2，每一项都已修正或已记录。
2. **合并预演**：在另一台机器的 PostgreSQL 16.15 上，把 `main` `fc139c868e` 与 PR-3a 临时合并，从空库全量迁移 427 条。
   - 用旧 head `68e40323bd` 合并时，旧名 `zzzz20261008090000_create_task_m4_tables` 排在倒数第二，在 `main` 于 2026-10-08 新增的 `zzzz20261008120000_add_stock_prep_pull_permission` 之前；`--rollback` 回退的是那条迁移，M4 的表仍在。这不满足 PR-3a 自己的合并前规则（设计 §2.1）：迁移的完整文件名要排在合并时 `main` 的全部迁移之后，合并前按 `main` 届时的最大前缀再核一次。
   - 重新定名后再做同一预演：本迁移最后执行；`--rollback` 只回退本迁移，台账 427 → 426，事先写入的授予行 1 / 1 / 1 不变；再迁移只执行本迁移一条，目录快照 139 行逐字节相同；迁移文件被删掉时，`migrate.ts` 以 `corrupted migrations` 退出 1（PR-3a 记录 §1009.3）。
3. **各 PR 当日的改动**（各 PR 只改自己的文件；每条按该 PR 的记录、提交或正文里当日那一节的说法转述，括号里是出处）：
   - PR-3a（记录 §1009「2026-10-09 迁移重新定名与门 15」）：按设计 §2.1 的规则（见上条），迁移重新定名为 `zzzz20261009130000_create_task_m4_tables`，迁移正文不变。把 manifest 的 `purpose` 改回旧名时，manifest 测试 36 格中有 1 格变红（§1009.1）。门 15：本 PR 在 `packages/core-backend/src` 下新增的注释共 1381 行（26 个文件），按记号表扫描 0 命中（改前 7 行），注释里点名其他线的符号由 8 个降到 0；只改注释，去掉注释后的打印结果逐字节相同（§1009.2）。
   - PR-3b（记录 §1009b「2026-10-09 改叠到重新定名之后的 PR-3a」）：改叠到重新定名之后的 PR-3a 上，三个开关的 manifest `purpose` 写现名，manifest 测试 39 / 39。门 15：新增的 920 行注释（19 个文件）里，4 行用另一条线的名字称呼集成表与身份表，改写后 0 行；写到 DingTalk 的 25 行讲的是本 PR 的通道本身，保留（§1009b.3；门 15 的读法当晚已裁，§7.1）。
   - PR-3c（记录 §11「第二轮修复」、§12「第三轮」）：提交之后才发送的前提格，规则改为离开 `catch` 的每条路径都抛出，且没有任何写法吞掉语句的错误。格里另读 `catch` 与 `finally` 中的 `return` / `break` / `continue`，以及注释行以外的 `Promise.allSettled` / `race` / `any`。写入者普查改为认 `ONLY` 与带括号的 `SET` 列清单。27 个变异中 24 个变红，3 个对照按设计存活（§11）。发送失败的日志改为只记一个码：这一稿（`b801bd53da`）的码取自错误自带的 `code`，没有时取类名，再没有时为 `unknown`；`task-counts-realtime` 由 17 格增至 19 格，5 个日志变异各自只红应红的格（§12.2、§12.5）。当晚按审阅发现改为固定码，见 §4.6。
   - 前端（验证记录「2026-10-09 修复轮」）：
     - 门 15：新增注释 1195 行，命中由 7 行降到 0。
     - 清单页清单项区的中文标题换了一种同义写法，英文不变。
     - 计数 socket 的令牌规则见 §2.7；`tasks-badge-m4` 加一格，把实现改回旧形时，88 格中恰好这 1 格变红。
     - owner 裁定只按条目 id 与日期引用。
     - 结果：任务守卫 24 文件 1934 格，必需 web lane 634 文件 12418 格，`vue-tsc` 0，token 清单 560 个 `MANIFEST MATCHES`，D = T = G = 23。
   - 任务 E（`3ac4a7ebc5` 的提交与 PR 正文，只改文档）：设计与验证记录引用 2026-10-09 的裁定时只写日期；验证记录里两处写「未做」的地方改为现状（已作为 Draft #6249 推送，未合并，无 DDL）；PR 正文列出四项与已裁取值的偏离，待 owner 逐项表态。
   - 任务 D（`224eb7b96f` 的提交，只改文档）：收窄后的 R12 写成规则；已裁条目按 id 引用，R04、N1、N2 记为 2026-10-07 已裁；设计 §1 改为七个新模块。
   - 锁 R01（`126e9bd182` 的提交与 PR 正文）：门 26 的前端重拉写成按信号窗口计，属于起草方设计。只改门 26 那一行，不增删行，锁内两条自检在新 head 上重跑输出不变。这一条当晚由 owner 裁定（§7.1），按裁定的修订见 §4.6。
4. **重建与改叠**：
   - **PR-3a**：重建为 `main` `8f90307d5a` 上的单提交 `7338f52e11`。
     - 与 `main` 的三处文本冲突都两边保留：#6278 改写的 `scripts/ops/staging-tasks-smoke.mjs` 及其测试 harness，以及 `scripts/ops/global-history-flag-manifest.test.mjs` 同一位置两边各加的格。
     - M4 的 preflight 移植进改写后的脚本与 harness，happy path 断言数 99 → 100。两份任务 D 文档换成 `224eb7b96f` 的修订。
     - 重建后的本机结果：`tsc` 0；任务单测子集 29 文件 1160 格；迁移守卫三件 36 格；`staging-tasks-smoke` 191 / 191；flag manifest 38 / 38；鉴权门接线 3 / 3。
     - PostgreSQL 16.15 上：从空库迁移 427 条，本迁移最后执行；`--rollback` 只回退本迁移，再迁移后快照 139 行逐字节相同；lane 16 文件 708 / 708；鉴权门 86 / 86（§1009r）。
   - **PR-3b**：改叠为叠在 `7338f52e11` 上的单提交 `9c2f7ab487`，差异仍是 44 个文件。
     - 与 `main` 在两个 manifest 文件上的冲突两边都保留：先放 `main` 的两个审批红点开关，再放本 PR 的三个开关与一个数值旋钮。manifest 测试 41 / 41。
     - 重建后的本机结果：`tsc` 0；任务单测子集与守卫 38 文件 1519 格；迁移守卫 36 格；`staging-tasks-smoke` 191 / 191。
     - PostgreSQL 16.15 上：迁移 427 条；lane 20 文件 795 / 795（一遍）；鉴权门 86 / 86（§1009m.2、§1009m.5）。
   - **PR-3c**：改叠为叠在 `7338f52e11` 上的单提交 `b801bd53da`，与 `main` 没有冲突。
     - 重建与第三轮之后的本机结果：`tsc` 0；任务单测 31 文件 1241 格。
     - PostgreSQL 16.15 上：迁移 427 条。lane 17 文件第一遍 728 / 729：PR-3a 的 `task-m4-dates` 有一格在机器高负载时超过 30 秒时限，该文件本轮没有改。第二遍 729 / 729，最终提交上另跑一遍也是 729 / 729。鉴权门 86 / 86（§12.4、PR 正文）。
   - **推送之后的 CI**：`tasks-realdb`（postgres:16）三张 head 都通过：#6266 run 37919022462，16 文件 708 passed；#6281 run 37919030353，20 文件 795 passed；#6269 run 37919036262，17 文件 729 passed。
5. **守卫加强**（防止解冲突时两边都保留）：
   - 改的是 PR-3b records 守卫里核对 outbox 行事件 id 的那一格。原先它只读最后一条事件 INSERT；现在逐个触点钉住事件 INSERT 的类型与顺序：记录的每个事件恰好对应一条 INSERT。
   - 与 PR-3c 合并时，如果两边都保留，没有删掉 PR-3c 一侧那行裸的事件写入，这一格就会变红，不论哪一侧排在前面。
   - 变异：五个回调各在两个位置多写一次事件，加上 `deleteTaskById` 的两处，共 12 个，全部变红。对照：用旧写法时，`completeTask`、`reopenTask`、`switchCompletionMode`、`deleteTaskById` 四处前置位置的变异下，整个文件仍是 72 / 72 全绿。
   - 格数仍是 72。这一格在本地跑，也在基分支为 `main` 时的 `plugin-tests` 里跑（§1009m.3）。
6. **R01 时点的改正**：PR-3a、PR-3b、PR-3c 的记录、正文与提交信息都写明：R01 的 ①–③ 是合并之前的判定，只有 ④ 在合并之后（PR-3a §1009r.3、PR-3b §1009m.4、PR-3c §12.3）。
   - 判定用合并前的最终候选集成树：含 #6248 的 `main`，加上按合并顺序叠好的 #6266、#6281、#6269、#6265，冲突按各 PR 写明的解法解好。
   - 判定记录要在 M4 的任何一张 PR 合并之前留下。这一判定还没有做（§5 第 4 条、§6.1）。
7. **各记录写明的 NOT RUN**（写于推送之前；推送之后的 CI 见 §4.2）：
   - R01 ①–③ 的判定本身；
   - 三张后端 PR 重建轮的全量单测；
   - PG14；
   - 真实 socket 端到端；
   - 前端修复轮的真机走查；
   - staging 与生产：没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。

### 4.6 2026-10-09 晚：按 owner 裁定与一条审阅发现的修订

本节转述各分支当晚的提交与记录，精度以它们为准。四项修订都已定稿，下面写的是定稿提交；本文写成时（2026-10-10）四者都没有推送，CI 没有在它们上面跑过。§4.2 的读数属于各 PR 当时已推送的 head。

1. **PR-3c**（设计修订 7、8；验证记录 §12.2、§12.4–§12.6 按这两版改写）：定稿为叠在同一 `7338f52e11` 上的单提交 `4e58af6a7b`；推送前 #6269 的 head 是 `b801bd53da`。
   - 起因是一条审阅发现：上一稿从错误对象取码，而错误自带的 `code` 与类名本身可能带上取值；`code` 或 `name` 是会抛错的 getter 时，同步那一路的异常会从 `publish()` 抛出，异步那一路会变成未处理的拒绝。
   - 现在：日志只记固定说明与固定码 `TASK_COUNTS_SEND_FAILED`；从错误算码的函数删掉，`catch` 不再绑定错误。设计写明错误与日志不带取值是规则，不是可选的加固，仓库里别处把错误对象交给日志的写法不改变这一点（设计 §4.3）。
   - 单测：日志格由两格换成四格。前两格是同步抛错与被拒绝的 promise，错误带标记 message 与标记 `code`；后两格的错误，其 `code` 与 `name` 都是会抛错的 getter，同步抛出与被拒绝各一格。四格都断言日志的全部调用恰为固定说明加固定码；前两格另断言日志参数里没有标记，后两格另断言 `publish()` 不抛、另一名收件人照常收到、没有未处理的拒绝。修订 8 把后两格的未处理拒绝监听器改为排在最前面登记、断言调用次数为 0：测试框架自己的监听器读拒绝原因的 `name` 时会抛出，排在它后面的监听器看不到这种拒绝。`task-counts-realtime` 17 → 21 格，任务单测子集 31 文件 1243 格，`tsc` 0。
   - 变异：5 个（把原始错误交给日志、码取错误自带的 `code`、meta 另带 message、换回上一稿的整个文件、换一个固定码）各让这四格全红，同一文件其余 17 格都绿，5 次还原逐字节相同；修订 8 之后在改动后的单测文件上重跑，结果相同。修订 8 另加 2 个（处理函数记完日志后把原错误再抛出；去掉处理函数），在改动前后的单测文件上各跑一遍：改动后两个都让第四格红在未处理拒绝那条断言上；改动前，第一个变异下这四格都绿（记录 §12.5）。
   - 修订 8 另把设计 §12 第 4 条改写为前端按门 26 的固定窗口合并重拉（§2.7）。`src` 与修订 7 相同。
   - 另一台机器的 PostgreSQL 16.15：从空库迁移 427 条；lane 17 文件一遍 729 / 729；鉴权门两遍各 86 / 86（记录 §12.4）。这几遍运行所在的提交与定稿的 `src` 相同，只差两份文档与 `task-counts-realtime` 单测文件，真库 lane 与鉴权门都不跑这个单测文件。
   - 记录写明未跑：CI；全量单测；lane 只跑了一遍；修订 8 之后没有重跑真库 lane 与鉴权门；真实 socket 端到端（记录 §12.6）。
2. **前端**：在 `0a4dfd6ee9` 之上加六个提交，最新为 `734ef4c3af`；推送前 #6265 的 head 是 `0a4dfd6ee9`。其中两个提交改 spec，后一个同时改两个生产文件的注释与设计；其余四个只改文档（验证记录「2026-10-09 信号窗口逐条格」与「2026-10-09 门 26 前端格按格名」两节）。
   - 先按门 26 的裁定在 `tasks-counts-realtime.spec.ts` 加一组四格，每条窗口规则一格，按字面毫秒推进，从而钉住 500 这个数。随后按锁定稿列出的格名改名、拆分，带 `gate26|` 前缀的格恰为七个：`gate26|重拉格`、`gate26|时区格`、`gate26|到点格`、`gate26|提前格|轮询`、`gate26|提前格|总线`、`gate26|另开窗口格`、`gate26|在途格`，各一格，时刻都按字面毫秒写。两个提前格先断言窗口到点的读取已经排定，再断言窗口里开始的读取把它取消；在途格断言在途的读取返回时窗口不关，这条信号之后 500 ms 仍有一次请求。
   - 生产代码只改注释：`useTasksBadge.ts`、`useTasksCountsRealtime.ts` 里把 `[fe-51]`、`[fe-52]` 标为 2026-10-09 已裁；行为不变，`useTasksBadge.ts` 本来就按这些规则工作。
   - 变异：加四格那一轮 12 个，全部变红（含 1 个对照）；按格名那一轮 17 个，全部变红，其中 13 个与锁里前端的负控丁–癸同形，每个都让锁为它点名的格变红，另 4 个锁里没有为它们点名的格。每次还原都逐字节一致。
   - 守卫 24 文件 1940 格全绿（1934 加两轮净增的 6 格）；`vue-tsc` 0；token 清单 560 个 `MANIFEST MATCHES`；格名核对（锁定稿对前端定稿）退出 0，四个负控各退出 1。
   - 记录写明未跑：CI；整条必需 web lane 与 `apps/web` 全量；真机；真实 socket 端到端。
3. **锁 R01 增补**（#6248）：在 `126e9bd182` 之上加两个提交，最新为 `95794d2c23`；推送前 #6248 的 head 是 `126e9bd182`。改动都是原地改写，不增删行，锁仍是 919 行：
   - 门 26：前端重拉的窗口规则按 owner 2026-10-09 裁定写成，带裁定括注（规则同 §2.7）；正控把前端格按格名列为上面的七格，时刻按字面毫秒写；负控丁扩写，新增戊至癸。正控与负控仍是起草方设计。
   - 勘误：五句仍称 §12 门表 PROPOSED 的状态句（抬头状态行、§0 末段、§9「门 19 投影端」一行、§12 讲证据 lane 的一段、§13-12）改为 2026-09-28 已 ratify（评论 5871552862），所在行的其余文字不变。
   - §11 M4 行：写明 ①–③ 是合并之前的判定、在候选集成树上做，④ 在合并之后；候选集成树的含义与判定记录的时点标为起草方设计（§6.1）。
   - 抬头记下这三处改动，并以 owner 将在 #6248 上亲写的确认评论为出处；评论 id 仍是占位，待回填（§6.1）。本文在定稿上重跑锁内两条自检，输出与 `126e9bd182` 上相同，都退出 0。
4. **任务 E**（#6249）：定稿为 `7137688372` 上的单提交 `39a2a29be9`（#6249 现有的三个提交也从 `7137688372` 起）；推送前 #6249 的 head 是 `3ac4a7ebc5`。与 `3ac4a7ebc5` 的树相比只改设计与验证记录两份文档的措辞，源码与测试不变（本文按树比较过）。

---

## 5. NOT RUN（明确未跑）

1. **CI**：托管 runner 作业在 2026-10-08 至 2026-10-09 间两度未启动（与代码无关），期间推送的 head 的检查在数秒内以失败结束、零步骤，不代表测试结论；这些 head 都已被 2026-10-09 的新 head 取代，#6278 已在必需检查全绿后合并。新 head 的检查状态见 §4.2：#6248、#6265、#6249、#6186 的 13 项必需检查全绿，#6266 在读数时只剩 `test (20.x)` 运行中，它于 19:41 以 success 结束（其后 gh 再读），13 项全绿。当晚的修订（§4.6）在本文写成时未推送，没有 CI 结果。以 PR-3a 分支为基的 #6281、#6269 没有必需检查，`plugin-tests`、`web-tests`、contracts、`migration-replay` 不触发，这四条 lane 只有本地结果（如 PR-3b 记录 总览.5）。13 项必需检查里 contracts 三项、`test (20.x)`（`plugin-tests` 的作业）、`web-tests`、`stock-prep PowerShell 5.1 acceptance` 共 6 项在这两张 head 上都没有检查运行：前 5 项所属的 lane 在 PR-3b 记录 总览.5 里记为不触发，第 6 项没有出现在任何记录里；这 6 项要等它们以 `main` 为基时才在 CI 上首跑。它们上面跑了的检查（含 `tasks-realdb`）全部 success。
2. **真实钉钉**：PR-3b 的 token 请求与发送都是替身，没有任何网络请求；R01 第 ④ 部分（`post-merge|23|staging真投递`：在 staging 做一次真实投递、outbox 留下一行）要 runner 加三个开关的输入、钉钉凭据与目录绑定，另行授权。
3. **M4 上 staging**：M4 迁移未应用到任何共享环境；PR-3a §12-Q10 已于 2026-10-09 裁定取 (i)，迁移本身仍待 #6266 合并后 owner 授权执行，前置与顺序见 §2.9；三个 P1 开关在所有环境关闭。
4. **R01 ①–③ 的判定**：是合并之前的判定，在合并前的最终候选集成树上做（§6.1）；这棵树以合并了 #6248 的 `main` 为基，#6248 还没有合并，所以判定还没有做（PR-3a §1009r.5、PR-3b §1009m.6、PR-3c §12.6 同记为未做）。`M2|` / `M3|` 全部行到目前只在 PR-3a + PR-3c 的 head 上重跑过，那是预备，不代替判定；门 26 整行要 PR-3c 与 FE-c 同在这棵树上。
5. **真实 socket 端到端**：浏览器真的收到 `tasks:counts-updated` 并重拉、两个后端进程下的投递，都没有做；PR-3c 的接线格停在 `CollabService.broadcastTo`。
6. **PostgreSQL 版本**：本地只有 15.17。另一台机器的 16.15 覆盖 PR-3a（2026-10-09 重新定名后与重建后的 lane 708、鉴权门 86 与迁移 / 回退 / 再迁移，记录 §1009.3、§1009r.4）、PR-3b（lane 795 ×3 与鉴权门 86，记录 §S-gate2.4；改叠与重建后各一遍 795）、PR-3c（闸修复那一轮 729 ×3，记录 §10.3；第二、三轮见 §11.2、§12.4；定稿的 `src` 上一遍 729，§4.6）与 runner 第四轮起的端到端（记录 §10.3，未在 15 上重跑）。CI 的 postgres:16 容器在 2026-10-09 的三张后端 head 上各跑过一次 `tasks-realdb`（§4.5 第 4 条）；`migration-prod-image-parity (postgres:15-alpine)` 在 #6266 `7338f52e11` 上通过（run 37919022386）；PG14（`plugin-tests`）在 #6266 上的结果以 `test (20.x)` 为准（19:14 读数时运行中，19:41 以 success 结束），在 #6281、#6269 上不触发。M3 后端合并前本地未跑 16，合并时由 CI 的 postgres:16 覆盖。
7. **真浏览器**：M3 前端没有真浏览器联调；M4 前端只有 FE-8 的一次 Chromium 中文走查，Firefox / Safari、英文界面、两标签并发 409、大数据量、页面级写后焦点都没有；闸审之后的焦点修复与 2026-10-09 修复轮（清单页标题、计数 socket 的令牌规则）只在 jsdom 验证。M2 的本地端到端只跑了管理员路径，`following` / `delegated` / `any_role` 视角与非零红点未覆盖。
8. **staging 冒烟的覆盖面**：#6278 合并后的 `smoke=tasks` 派发（run 37888015811）成功，覆盖 M2 与 M3 路由（99 条断言、残留 0，§4.4）；M4 路由没有冒烟（PR-3a 分支上的冒烟脚本只在 preflight 里查三张 M4 表）；考勤三个冒烟（ae4、mp6、otbank-v18）仍被 runner 拒绝，重新启用归考勤线。
9. **锁与门表**：`i-m4` 未入锁；门 19 的 M4 视图格、门 21 / 22 的 M4 行、门 23–26 全部候选；门 9、锁序控件、`src/multitable/task-*` 扫描根首个可跑为 M5；M5 候选门 M5-a…g 未编号。
10. **全量单测**：PR-3c 闸修复那一轮与 PR-3b 的若干切片没有重跑全量（只跑任务子集），上一次全量在各自记录的 head 上；2026-10-09 三张后端 PR 的改叠与重建轮都没有跑全量（PR-3a §1009r.5、PR-3b §1009m.6、PR-3c §12.6），PR-3c 的定稿也没有（§4.6）；本机 5 个与本线无关的文件（4 个 multitable-recovery、1 个考勤插件布局）因环境失败，未修。
11. **其他**：M3 契约里 `TASK_BUSY` 的 3 秒是否改 1 秒待 owner；PR-3b §13-Q23 / Q24 的两种情形没有格；leader 会话的 TCP keepalive 界限未采用；Node 18 未跑（`main` 已去掉矩阵）；任务 D 的 `isInDailyDigest`（TS）与 `buildTaskDailyDigestCondition`（SQL）的双形对拍留给 PR-3b 的真库格（`task-m4-scheduler` 有一格让两形在同一批 10 个任务上选出同样的 6 个，记录 §S5.5）。
12. **独立复闸**：PR-3a 的 S8–S10 闸修复本身未再过闸（其记录如此声明）；PR-3b 的再门审修复（S-gate2）之后另做了一轮独立核验（0 P1 / 0 P2，PR 正文「再核验」）。2026-10-09 各 PR 当日的改动、改叠与重建见 §4.5，当晚的修订见 §4.6；各 PR 的记录没有为这些改动另记闸审结论。

---

## 6. 合并计划与仍需的门

### 6.1 顺序与各自前置

M4 的合并流程，每一步都要 owner 单独点名或动作：

1. 按 2026-10-09 裁定修订的锁（定稿 `95794d2c23`，§4.6）推送到 #6248；owner 在 #6248 上亲写确认评论（锁 §14-2）；评论 id 回填到锁抬头并再推；owner 点名合并 #6248。
2. 在合并前的最终候选集成树上做 R01 ①–③ 的判定，并留下判定记录。
3. owner 逐张点名 #6266、#6281、#6269、#6265。

最终候选集成树是：含 #6248 的 `main`，加上按上述顺序叠好的 #6266、#6281、#6269、#6265，冲突按各 PR 写明的解法解好；各 PR 取推送后的最终 head，锁、PR-3c 与前端的定稿修订（§4.6）要先推送才在这棵树里。R01 只有 ④（staging 真投递一次）在合并之后，是 owner 的步骤。出处：`claude/tasks-lock-r01` 上锁 §11 的 M4 行（定稿 `95794d2c23` 写明 ①–③ 是合并之前的判定、在候选集成树上做，候选集成树的含义标为起草方设计）；PR-3a 记录 §1009r.3、PR-3b §1009m.4、PR-3c §12.3。

| 序 | PR / 步骤 | 前置（除 owner 点名外） |
|---|---|---|
| 1 | #6248 锁 R01 增补 | 门 26 的窗口规则与五句状态句的勘误已于 2026-10-09 裁定（§7.1）；按裁定的修订已定稿为 `95794d2c23`（§4.6），推送之后 owner 在该 PR 上亲写确认评论（锁 §14-2）；回填抬头的评论 id 并再推（PR 正文的核对命令输出为 0）；合并后 R01 的 `M4\|` 子集行与门 23–26 才计分 |
| 2 | R01 ①–③ 的判定（不是 PR） | #6248 已合并（R01 新加的行在它合并之前不计分）；在上述最终候选集成树上跑 ① 两条既有 `M4\|` 行、② R01 新加的每一条 `M4\|` 行（含门 23–26）、③ 全部 `M2\|` 与 `M3\|` 行，并留下判定记录；判定在 M4 的任何一张 PR 合并之前完成。PR-3c 在自己 head 上做过的 `M2\|` / `M3\|` 重跑是预备，不代替这一遍 |
| 3 | #6266 PR-3a | 第 2 步的判定记录已留下；以 `main` 为基，13 项必需检查须全绿（当前读数见 §4.2）。合并前按 `main` 届时的最大迁移前缀复核本 PR 的迁移名仍排最后，否则改名，PR-3b 随之改（PR 正文「合并前须知」）。2026-10-10 读 `main` `80cb873225`（#6288）：最晚的迁移仍是 #6282 的 `zzzz20261009120000_…`，排在 `zzzz20261009130000` 之前。合并前若 `main` 又改了三个 ops 冲突文件，要再核一次：其中 `scripts/ops/global-history-flag-manifest.test.mjs` 在 `8f90307d5a` 之后已由 #6282 改过；2026-10-10 用 `git merge-tree` 把 `7338f52e11` 与 `80cb873225` 试合并（不建工作树），没有文本冲突，这只核文本，不代替这次复核。本 PR 已带上任务 D 文档的 `224eb7b96f` 修订（两份文档逐字节相同），#6186 拟按被本 PR 取代关闭（§12-Q15）。§12-Q10 已于 2026-10-09 裁定取 (i)：本 PR 合并之后、staging 部署含它的镜像之前，经 owner 授权执行 staging 迁移，前置与顺序见 §2.9。`tasks-realdb` 在 `main` 跑过之后，由 owner 追加进必需检查（门 17 ③） |
| 4 | #6281 PR-3b | 叠在 #6266 之上的单提交，在 #6266 之后合并；以 `main` 为基之前，13 项必需检查里有 6 项没有在它上面跑过（§5 第 1 条）。与 PR-3c 在六个回调与两张清单上的冲突，由后合并的一方按 PR-3c 设计 §10 的唯一非机械一步解决；保留两边时 records 守卫变红（§4.5 第 5 条）。合并前若 `main` 又改了两个 manifest 冲突文件，要再核一次：这两个文件在 `8f90307d5a` 之后都已由 #6282 改过；同样的试合并（`9c2f7ab487` 对 `80cb873225`）没有文本冲突，也只核文本。无 DDL；三个开关的 staging 输入另需 runner 改动（§13-Q8）。门 15 的读法已于 2026-10-09 裁定（§7.1）；本 PR 写钉钉通道本身的 25 行按逐行证据归类（PR-3b 记录 §1009b.3），`M2\|15\|整门` 的结论仍在第 2 步的判定里得出 |
| 5 | #6269 PR-3c | 叠在 #6266 之上的单提交，在 #6266 之后合并；与 #6281 的冲突同上；门 26 后端格与 FE-c 前端格同行，判定时两者都在候选集成树上。定稿的单提交 `4e58af6a7b`（§4.6）要推送之后才有 CI 结果 |
| 6 | #6265 M4 前端 | 在 #6266 之后合并；与 #6281、#6269 无直接依赖；必需 web lane 与 `.tokens` 守卫已在 CI 上跑过（head `0a4dfd6ee9`）；当晚在其上加的六个提交（最新 `734ef4c3af`；改 spec 的格、两个生产文件的注释与文档，§4.6）要推送之后才有 CI 结果；真机与 PR-3c 后端的联调仍 NOT RUN |
| — | #6249 任务 E | M5 纯函数，只建新文件；合并归 M5 的点名；PR 正文列的四项与已裁取值的偏离待 owner 逐项表态（§7.2）；任务 D 下次 rebase 时把 `addCivilDays` 改为 import；当晚只改文档的定稿 `39a2a29be9`（§4.6）要推送之后才有 CI 结果 |
| — | #6278 runner | 已于 2026-10-09 合并（`fc139c868e`），合并后的 staging `smoke=tasks` 已执行（run 37888015811，§4.4） |
| — | #6126 M3 契约 | 仍开着的 Draft（head `c117ab06ca`，base `main`）；实现已由 #6229 落 `main`（该 PR 评论 5903541072 已说明实现另开新 PR），契约正文以 `main` 的 M3 后端设计为准，PR 正文里的剩余步骤已过时；本文建议关闭为「已被 #6229 取代」或 rebase 后作 docs-only 合并，由 owner 点名 |

M4 退出条件（锁 R01 增补的 §11 M4 行）：① 两条既有 `M4|` 行全绿；② R01 新加的每一条 `M4|` 行全绿，含门 23–26 的四条整门；③ 把全部 `M2|` 与 `M3|` 行重跑一遍且全绿；④ 合并后由 owner 在 staging 做一次真实投递、outbox 留下一行（`post-merge|23|staging真投递`）。①–③ 是合并之前的判定，在上表第 2 步的最终候选集成树上做，④ 不挡它。已推送的 `126e9bd182` 把 ③ 写成在 M4 最终 head 上重跑，所指就是这棵树（PR-3a 记录 §1009r.3）；定稿 `95794d2c23` 把判定所在直接写进 M4 行（§4.6）。合并照锁 §14-5 另需独立合并授权。

### 6.2 剩余开发

- **M5 路由**：PR-4a（重复 / 字段等实体扩展）、PR-4b（附件）、PR-4c（投影）；依赖、里程碑与导出的归属以三者的设计为准（任务 E 设计 §3、§6、§7；验证 §5）；各自的路由表、开关与作业编排以三者的设计为准，本文不预写；三者都在 M4 合并授权之后起 Draft（S32 第二句，2026-10-09）。
- **M5 的起草方式**（owner 2026-10-09 裁定）：允许受控的堆叠起草；合并则按依赖关系逐张串行。S32 的前置满足之后，先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 以及对应的前端；基线一变就重建并重新验证。
- **M5 前端**：FE-d 详情（重复 / 里程碑 / 依赖 / 字段值 / 附件）、FE-e 清单页（字段绑定、开启投影、深链、导出）、FE-f 多维表工作台拦截（走 `multitable-web-guard`）。
- **锁 §2 承重两项**（owner 2026-10-09 裁定：二者都仍是承诺）。现状：两项都还没有实现，锁 §3 的范围行、锁 §6.2 与锁 §12 的门表里也没有承载它们的行或格；`main` 与各 M4 分支上，`GET /api/tasks` 只按视角取行、没有状态参数，`POST /api/tasks/:id/complete` 不读 `scope`（只有 reopen 读）。
  - 创建人为所有负责人完成（锁 §2 第 3 条）：放进 PR-4a 的第一片，排在重复任务的派生之前。验证要覆盖两点：只有创建人能这样完成；完成动作重复执行时，事件不重复产生。
  - 已完成 / 全部视图与默认只看未完成（锁 §2 第 1 条）：状态筛选这一核心部分在 M4 之后作为单独一次交付，排在 FE-e 之前。状态筛选与四种角色视角相互正交；列表与 `total` 用同一个条件。排序与字段显隐不在核心部分里，另列为单独的项。
- **任务内历史与跨任务动态**（owner 2026-10-09 裁定）：任务内历史在 M5 之后单独补齐；跨任务的动态页仍然后置（锁 §13-34）。任务内历史不是锁的条款，计划与锁在这一项上的差异须登记，本文在此记下（锁未改）。历史接口返回事件时，不能把 payload 原样交出：例如 payload 里的清单 id，要先过清单可见性的校验。
- **M5 退出**（S31）：五条既有 `M5|` 行；M5 候选门的编号待 R01 落锁后定；最终 head 上回归 M2 / M3 / M4 的全部行；合并后的 staging 验证由 owner 另行点名。
- **收尾项**：任务 D 的 `buildTaskByIdCondition` 已由 PR-3a 落地；`task-notifications.ts` 的 `attachment_added` 与 `task-ids.ts` 的 `tfld` / `tatt` 分别归 PR-4b S5 与 PR-4a S0；M3 评论分页与 M4 分页两套规则是否合流（PR-3a §12-Q8）。

---

## 7. owner 问题（按 PR、按编号；各自文档里附缺省值）

### 7.1 2026-10-09 已裁的六项

owner 2026-10-09 对此前列在本节的六项作了裁定。下面按条目写成规则，登记见 §3；这些裁定都不是合并、DDL 执行或开关的授权。

1. **门 26 的信号窗口与状态句勘误（#6248）**：前端的重拉以固定 500 ms 的窗口合并信号。窗口开着时新开始的一次读取，可以提前回答此前已到的信号；一次读取开始以后才到的信号，自己另开一个窗口；信号到达前就已发出、尚未返回的读取，抵消不了它。锁内五句仍称 §12 门表 PROPOSED 的状态句一并勘误，原 ratify 依据（PR #5845 评论 5871552862）不变。前端的规则与格见 §2.7、§4.6；按裁定修订的锁已定稿为 `95794d2c23`，本文写成时未推送（§4.6）。
2. **门 15 的读法**：判断依据是注释有没有点名其他线的具体符号。钉钉这个品牌名，以及本任务通道自身的常量与错误码，都不算违规；逐行归类的证据要留着，也不按整个文件豁免。这是读法，不是门 15 的结论：`M2|15|整门` 仍在 R01 ①–③ 的判定里、于最终候选集成树上得出（§6.1）；#6281 那 25 行的逐行证据在 PR-3b 记录 §1009b.3。
3. **锁 §2 承重两项**：二者都仍是承诺。创建人为所有负责人完成放进 PR-4a 的第一片，排在重复任务的派生前面，验证覆盖只有创建人能这样完成、重复执行不重复产生事件；已完成 / 全部视图的状态筛选核心在 M4 之后单独交付，排在 FE-e 前面，它与四种角色视角相互正交，列表与 `total` 用同一个条件；排序与字段显隐另列（§6.2）。
4. **PR-3a §12-Q10**：取 (i)，staging 迁移经 owner 授权之后执行。执行之前按目标 SHA 列出完整的 pending 集合（#6264、#6282 的迁移届时若仍未应用，也在其中），A-3 继续排除；备份与克隆演练在前，随后迁移、部署，最后冒烟（§2.9）。
5. **任务内历史与跨任务动态**：任务内历史在 M5 之后单独补齐；跨任务的动态页仍然后置；计划与锁在这一项上的差异要登记（§6.2）；历史接口不把事件 payload 原样交出，其中的清单 id 先要过清单可见性的校验。
6. **M5 的起草方式**：受控的堆叠起草；合并则按依赖关系逐张串行。S32 的前置满足之后，先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 及对应的前端；基线一变就重建并重新验证（§6.2）。

### 7.2 仍待 owner 的问题

| 文件 | 编号 |
|---|---|
| 锁 / #6248 | 亲写确认评论（锁 §14-2；在按 7.1 第 1 条修订的锁推送之后）；`i-m4` 块何时、由哪个 PR 写进锁（PR-3a §12-Q1）；PR 正文里其余的「起草方设计（需要 owner 确认）」（门 26 前端重拉那一条已由 7.1 第 1 条裁定）；PR 正文「需要 owner 回答」：M4 行的 ③ ④ 是否也适用于 M5（2026-10-09 的 S31 已定 M5 退出条件，见 §6.2，可在 PR 上注明） |
| M3 后端（已合并）设计 §3.7 末、验证 §20 | `TASK_BUSY`：软删行锁语句限时 3 秒是否改 1 秒；客户端是否须退避重试 |
| PR-3a 设计 §12 | Q2（改期时 `remind_at`）、Q3 的三处自选（码名、操作者豁免、转让目标校验）、Q4（N1 归哪个 PR，PR-3b 已按建议落实）、Q5（基分支）、Q6 的一处拆法、Q7（分组细则）、Q8(b)（两套分页是否合流）、Q9（`task_lists` 不建 `owner_id`、`icon` 建而不接）、Q11（Draft 迁移口径与 `remind_at` 索引谓词）、Q12（`badgeScope` 键的出现规则）、Q13（日期写入两条严格规则、`description` 上限）、Q15（#6186 的处置）、Q17（所有者离开 org 的清单）；Q10 已裁（7.1 第 4 条） |
| PR-3b 设计 §13 | Q2（投递保证形状、是否加状态机触发器）、Q3（关闭语义与 24 小时新鲜度）、Q4（汇总迟到上限）、Q5（汇总在发送时计算）、Q6（文案不带 deep link）、Q7（`outcome_unknown` 人工核对路径）、Q8（staging 真投递由哪个 PR 改 runner）、Q9（三开关以 `TASKS_ENABLED` 为前提、投递由本 tick 的 leader 跑）、Q10（落锁）、Q12（基分支）、Q13（钉钉集成所在 org）、Q14（`buildTaskByIdAnyStateCondition`）、Q15（集成停用时 skipped）、Q16（逐行标签）、Q17（claim 索引建议）、Q18（出站白名单）、Q19（manifest 是否带规则）、Q20（配置只取集成行）、Q22（加人致重启的新负责人是否收通知）、Q23（自管重启翻转是否通知）、Q24（R06 按处理时刻还是按 `remind_at` 时刻） |
| PR-3c 设计 §11 | Q2（不改变谓词输入的模式切换是否发）、Q3（只改时区是否收窄）、Q4（设置变更是否给本人房间发）、Q6（R01 ③ 那一遍由谁跑；时点已由 R01 定为合并之前）、Q7（多 org 用户的多余重拉是否接受） |
| M4 前端设计 §12 | Q1–Q4、Q6–Q11、Q13、Q14、Q16–Q35（Q5、Q15 已裁；Q12 前提不成立）；另有验证记录「闸审之后的修复」§7 的三项（409 后自动填入的浏览器时区是否算本人改动；重拉后草稿过不了日期预检；只经清单可见者移出最后一个清单后的落点）待 owner 定；`apps/web/src/router/appRoutes.ts` 里一处 `main` 上早已存在的他线路由标题，#6265 不改，交 owner 定（验证记录「2026-10-09 修复轮」§4） |
| 任务 E 设计 §7 | 问题 1（改当前实例截止日或规则后，后续各期的锚点）、问题 2（CSV 的 dateTime 时区）、问题 3（重复 `count` 越界的码）；偏离 7、17、18、20 与每任务附件上限的计数口径是在已裁文字之上的读法，待逐条表态（PR 正文 2026-10-09 起把四项偏离各列 A / B 两个选项与建议）；D 编号未在 2026-10-09 的裁定里点名 |
| 任务 D 设计 §5 | 标「own choice」的 7 行自选 |
| runner #6278 验证 §6 | `staging-tasks-smoke.test.mjs` 是否进 PR 门禁；是否保留 `MEMBER_TOKEN` 用例；outsider 令牌权限；清理助手真库测试是否在 CI 启用 |
| M5 | S31 候选门行入锁与编号；PR-4a / 4b / 4c 在 M4 合并授权之后起 Draft（S32），起草方式已由 7.1 第 6 条裁定 |

---

## 8. 文档索引

**`main` 上**

- 锁：`docs/development/task-feature-design-lock-20260917.md`；普查：`task-feature-census-20260917.md`；M0 报告：`task-feature-m0-development-20260917.md`
- 任务 B：`task-b-pure-functions-design-20260926.md` / `-verification-20260926.md`
- 任务 C：`task-c-m3-pure-functions-design-20260928.md` / `-verification-20260928.md`
- M2：`task-feature-m2-design-verification-20260927.md`、`task-m2-backend-design-20260927.md` / `-verification-20260927.md`、`task-m2-frontend-design-20260927.md` / `-verification-20260927.md`
- M3：`task-m3-backend-design-20260928.md` / `-verification-20260930.md`、`task-m3-frontend-design-20260928.md` / `-verification-20260929.md`
- runner 冒烟（#6278，2026-10-09 合并为 `fc139c868e`）：`staging-runner-smoke-bundle-design-20261007.md` / `-verification-20261007.md`

**Draft 分支上**（以 `分支:路径` 读取）

- 任务 D（#6186，`224eb7b96f`）：`claude/tasks-d-pure:docs/development/task-d-m4-pure-functions-design-20260930.md` / `-verification-20260930.md`
- 锁 R01 增补（#6248，`126e9bd182`）：`claude/tasks-lock-r01:docs/development/task-feature-design-lock-20260917.md`（相对 `main` 只改抬头、§11、§12；按 2026-10-09 裁定的定稿 `95794d2c23` 另改 §0、§9 与 §13-12 各一句状态句，§4.6）
- M4 PR-3a（#6266，`7338f52e11`）：`claude/tasks-m4-pr3a:docs/development/task-m4-pr3a-backend-design-20260930.md` / `-verification-20260930.md`
- M4 PR-3b（#6281，`9c2f7ab487`）：`claude/tasks-m4-pr3b:docs/development/task-m4-pr3b-backend-design-20261001.md` / `-verification-20261001.md`
- M4 PR-3c（#6269，`b801bd53da`；定稿 `4e58af6a7b`，§4.6）：`claude/tasks-m4-pr3c:docs/development/task-m4-pr3c-backend-design-20261008.md` / `-verification-20261008.md`
- M4 前端（#6265，`0a4dfd6ee9`；定稿为其上六个提交，最新 `734ef4c3af`，§4.6）：`claude/tasks-m4-frontend:docs/development/task-m4-frontend-design-20261007.md` / `-verification-20261007.md`
- 任务 E（#6249，`3ac4a7ebc5`；定稿为单提交 `39a2a29be9`，§4.6）：`claude/tasks-e-pure:docs/development/task-e-m5-pure-functions-design-20261007.md` / `-verification-20261007.md`

**本文未核实、只按各记录转述的项**：各 Draft 分支记录里的本地命令结果与变异表（本文没有重跑，锁内两条自检除外）；PostgreSQL 16.15 上的运行只按 PR-3a、PR-3b、PR-3c 与 runner 的验证记录转述。本文核过的项：§4.2 的检查状态（gh 读数）、§4.5 第 4 条三次 `tasks-realdb` 的计数与 postgres:16 镜像（run 日志）、§4.4 run 37888015811 的断言数与残留（run 日志）、PR-3a 的两份任务 D 文档与 `224eb7b96f` 的同名文件逐字节相同、§6.2 锁 §2 承重两项的现状所引的锁行与路由代码（`main` 与各 M4 分支）、§4.6 四个定稿修订的代码与文档改动（按提交内容读过：PR-3c 定稿相对 `b801bd53da` 只改 `task-counts-realtime.ts`、它的单测与两份文档；前端两个生产文件只改注释；任务 E 与 `3ac4a7ebc5` 只差两份文档；运行结果仍按记录转述）、§4.6 第 3 条锁内两条自检在定稿上的重跑、门 26 的七个格名在锁定稿与前端定稿之间逐个对上且 spec 里各一次、§4.2 与 §5 第 1 条里 #6266 的 `test (20.x)` 于 19:41 结束（gh 再读）、2026-10-10 gh 再读的各 PR head、§2.9 所引 #6264 与 #6282 都已合入 `main` 并带有迁移、§6.1 所引 `main` `80cb873225` 上的迁移、#6282 对两个 manifest 文件的改动与两次试合并；其余 staging run 编号按当时记录。
