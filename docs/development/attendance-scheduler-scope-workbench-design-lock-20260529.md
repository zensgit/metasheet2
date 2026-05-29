# 考勤管理员工作台 · 排班管理范围 — design-lock（仅设计 / 不开工）

> Date: 2026-05-29 · Author: Claude · Status: **DESIGN-LOCK — 设计冻结，待显式 opt-in 才实现，不含任何代码**
> 证据基准：下文所有 `file:line` 为 **re-grep-verified @ origin/main `ca93e3a0b`（#2061）** 的快照——**symbol 名为稳定锚，行号为该 SHA 快照**（不写"当前 main"，main 为移动靶）。本分支为满足分支保护"须最新"会 rebase 到 main 当前 tip；此类 rebase **不改变上述验证** —— 所依赖的 `index.cjs` / `AttendanceView.vue` / migration 自 `ca93e3a0b` 起未变（如变动则重新 re-grep）。
> 复核（2026-05-29 落地 rebase）：在 `ca93e3a0b` 上 re-grep 确认锚点全部准确 —— `index.cjs` enums `:48-49` · normalize `:7467-7508` · match `:7534`；CRUD `GET:26865 / POST:26900 / PUT:26951 / DELETE:27015`；zod `:26467`；summary `:27264`；`AttendanceView.vue` chip `:7240`；migration `:90-112`。
> 动机来源：对标研究稿 PR #2057（`docs/research/dingtalk-attendance-benchmark-refresh-20260529.md`）§5 — 其中「子管理员范围」被判为 P1 里**唯一锁内可启动**项（模型已落，缺工作台包装）。本设计只写 MetaSheet 自己的口径，不引竞品概念。

## 0. 约束（hard constraints，本设计的边界）

- **仅设计、不开工、不写代码**：本文产出即交付物；实现是后续独立 opt-in。
- 范围**收窄**为两件事：① 既有 `attendance_scheduler_scopes` 的**工作台 UI 包装**；② dept/group 等**范围目标的选择器 UI**。
- **不碰** `plugins/plugin-integration-core/*`、中央 RBAC、auth（K3 PoC Stage-1 锁）。
- **不新增权限模型**：复用既有 subject × scope-targets × actions 三元 + 既有 `withPermission('attendance:admin')` 守卫。
- **不接 enforcement**：见 §5（运行时强制属独立后续 opt-in，明确出范围）。

## 1. 现状（已验证 @ `ca93e3a0b` / #2061）—— 证明「扩展非重建」

后端模型 + CRUD + 校验**已存在**，本工作台只在其上加 UI（symbol 名为主，行号 @ `ca93e3a0b`）：

| 组成 | 现状 | 证据（symbol @ 行号） |
|---|---|---|
| 表 `attendance_scheduler_scopes` | `subject_type` · `subject_ref` · `actions text[]` · `scope jsonb` · `is_active` · 审计列 | `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts` `createTable('attendance_scheduler_scopes')` `:90-112` |
| subject 类型（谁） | `user` / `role` / `role_tag` | `ATTENDANCE_SCHEDULER_SCOPE_SUBJECT_TYPES` `index.cjs:48`；zod `:26467` |
| actions（哪些操作） | `view` / `edit` / `import` / `export` / `clear` / `approve` / `dispatch`（7 项） | `ATTENDANCE_SCHEDULER_SCOPE_ACTIONS` `index.cjs:49` |
| scope 目标（管哪些范围）| **6 类已就绪**：`scheduleGroupIds` · `attendanceGroupIds` · `userIds` · `departments` · `roles` · `roleTags` | `normalizeAttendanceSchedulerScopeBody` `index.cjs:7470` · `attendanceSchedulerScopeHasTargets` `:7476` |
| CRUD 路由 | `GET`/`POST`/**`PUT`**/`DELETE` `/api/attendance/scheduler-scopes`，均 `withPermission('attendance:admin')`（更新为 **PUT 全量**，非 PATCH） | `index.cjs` GET `:26865` · POST `:26900` · PUT `:26951` · DELETE `:27015` |
| 校验 | `schedulerScopeCreateSchema`（subjectType/actions enum、scope record）+ `normalizeAttendanceSchedulerScopeInput`（≥1 target 否则 400） | zod `index.cjs:26467` · `normalizeAttendanceSchedulerScopeInput` `:7482`（≥1 target `:7499` / ≥1 action `:7495`）|
| 计数同步 | summary 已暴露 `schedulerScopes` 数量 | `index.cjs:27264`；前端 `AttendanceView.vue:7240` |
| 现有前端 | **仅一个计数 chip**「调度权限 / Scheduler scopes」，**无任何管理界面** | `AttendanceView.vue:7235-7240` |

> **关键结论**：用户口中「补 dept/group 范围目标」在**数据模型 / CRUD / match 逻辑里已全部存在**（`departments` / `attendanceGroupIds` / `scheduleGroupIds` 均在 `normalizeAttendanceSchedulerScopeBody` `:7470`）。真正缺的**只有前端**：(a) 一个管理工作台，(b) 范围目标的可视化选择器。**本设计不动后端。**

## 2. 目标 / 非目标

**目标**
- G1 在 AttendanceView 内新增「**考勤管理员工作台**」入口，内含「**排班管理范围**」模块，采用与考勤组 admin 一致的 **list-detail** 形态（视觉/交互复用既有 list-detail 壳）。
- G2 让 admin 可视化地 **查看 / 新建 / 编辑 / 停用** scheduler scope，全程只调既有 4 个 CRUD 路由。
- G3 为 scope 的 6 类目标提供**选择器 UI**（dept / 考勤组 / 排班组 / 员工 / 角色 / 角色标签），复用 AttendanceView 已有的对应数据源/选择控件。
- G4 诚实呈现「**意图态**」：scope 当前是"已登记的管理意图"，尚未在运行时强制（见 §5），UI 必须明示，避免管理员误以为已生效。

**非目标（明确不做）**
- N1 不接 enforcement（不把 `attendanceSchedulerScopeMatchesTarget` 接到排班/导入/导出/清空/审批/调度路由）。
- N2 不新增 subject 类型 / action / 目标类型 / 表 / 列 / 路由。
- N3 不动中央 RBAC / auth / integration-core。
- N4 不做移动端、不做批量导入 scope、不做 scope 变更审批流（后续可选）。

## 3. 设计

### 3.1 落点与 IA
- 入口名「**考勤管理员工作台**」，内部模块「**排班管理范围**」（或「排班范围登记」）。**不叫「排班权限」**——enforcement 未接线时"权限"易让用户误以为已运行时生效（见 §3.5/§8-1）。沿用既有 `tr()` 双语串模式，不引入新 i18n 机制。
- 既有计数 chip（`AttendanceView.vue:7240`，现文案 `tr('Scheduler scopes','调度权限')`）保留为入口/概览；点击进入工作台模块。

### 3.2 list-detail 布局（复用考勤组 admin 形态）
- **左栏（list）**：scope 列表，按 `subject_type` 分组（员工 / 角色 / 角色标签 三态本期全做，§8-3），每行展示 subject + 动作徽章 + 目标摘要（"3 部门 · 2 排班组"）+ 启用状态。支持 `includeInactive` 切换（GET 路由支持，`index.cjs:26870`）。
- **右栏（detail / editor）**：选中行只读详情 + 编辑表单；"新建"为右栏空表单。subject 选择器覆盖 `user`/`role`/`role_tag` 三态。

### 3.3 范围目标选择器（G3，本设计核心 UI）
6 类目标 → 6 个选择控件，统一映射到 `scope` jsonb 的 6 个数组键（命名必须与 `normalizeAttendanceSchedulerScopeBody` `index.cjs:7470` 完全一致）：

| UI 控件 | scope 键 | 数据源（复用） |
|---|---|---|
| 部门多选 | `departments` | 既有部门数据 |
| 考勤组多选 | `attendanceGroupIds` | 既有考勤组列表 |
| 排班组多选 | `scheduleGroupIds` | 既有排班组列表 |
| 员工多选 | `userIds` | 既有员工搜索/选择器 |
| 角色多选 | `roles` | 既有角色 |
| 角色标签多选 | `roleTags` | 既有角色标签 |

- 客户端校验对齐后端：**至少 1 个目标**，否则禁用保存（后端 `:7499` 会 400）。
- "dept/group" 即上表前三项；这是用户所指"范围目标"的 UI 落地——**纯选择器，无模型变更**。
- **不做"无目标 = 全公司"**（§8-4）：空数组不暗示全公司；未来若需全公司应显式新增语义（见 §6 R4）。

### 3.4 动作选择
- 7 个 action 复选框（`view/edit/import/export/clear/approve/dispatch`），双语标签；**至少选 1**（对齐 zod `min(1)` 与 `:7495`）。

### 3.5 状态诚实标注（G4，关键设计决策 / §8-2）
- enforcement **未接线期间**：工作台顶部固定一条**明显说明条**——当前 scope 为"管理登记"，**运行时强制执行为后续能力**（不夸大）。
- 每条 scope 不显示"已生效/已拦截"等会误导的字样。
- enforcement **接线后**：说明条**降级**为小型状态标识 / 审计说明，不再长期占用一个大提示条。

### 3.6 只读契约清单（UI 仅调以下既有端点，不新增；行号 @ `ca93e3a0b`）
- `GET /api/attendance/scheduler-scopes?page&pageSize&includeInactive`（`index.cjs:26865`）
- `POST /api/attendance/scheduler-scopes`（`:26900`）
- `PUT /api/attendance/scheduler-scopes/:id`（**全量更新**，校验走 `schedulerScopeSchema`，`:26951`）
- `DELETE /api/attendance/scheduler-scopes/:id`（实为 `is_active=false` 软停用，`:27015`）

## 4. 验收标准（实现期对照，本设计不执行）
- A1 admin 能在工作台完成 scope 的 增/查/改/停用，全部经上述既有路由，**零新增后端**。
- A2 6 类目标选择器与 `scope` 6 键一一对应，往返不丢字段（**wire-vs-fixture**：须有 1 条集成测试断言 POST→GET 的 `scope` 6 键原样往返，杜绝字段在序列化中被吞）。
- A3 "≥1 目标 / ≥1 动作"前后端一致；缺失时 UI 阻断且不发请求。
- A4 §3.5 意图态说明条存在且不出现误导性"已强制"措辞。
- A5 i18n 走既有 `tr()` 双语模式；无裸串。
- A6 列表/编辑器复用考勤组 admin 的 list-detail 壳，视觉一致。

## 5. enforcement gap（出范围，但必须记录）
- `attendanceSchedulerScopeMatchesTarget`（`index.cjs:7534`）已实现六类目标 match，但**目前无任何调用方**（grep 仅见其内部 `scopeListCoversTarget` 调用 + export）。即 scope **未在运行时限制任何动作**——典型 *annotation-rich, enforcement-thin*。
- 本设计**有意不接** enforcement：接线会触及排班/导入/导出/清空/审批/调度路由与权限判定，属"修改权限行为"，**须独立 opt-in**（且部分逼近 RBAC 边界，需单独评估锁内可行性）。
- 因此工作台先交付"可视化登记 + 诚实标注"价值；enforcement 作为下一段单独 design-lock + opt-in。

## 6. 风险 / 依赖
- R1 误解风险：admin 以为配了就生效 → 由 §3.5 + A4 缓解。
- R2 目标键命名漂移：UI 键若与 `:7470` 不符则后端静默丢弃 → 由 A2 往返测试锁死。
- R3 数据源复用：6 个选择器依赖既有部门/组/员工/角色数据源在该视图可得；实现期先盘点缺口（见 TODO T2）。
- R4 全公司语义（§8-4）：当前**不做**"空数组 = 全公司"；若未来需要，须作为**显式** target（如 `orgWide: true`）新增，避免空数组被误判为"管全部"导致越权。

## 7. Gated TODO（🔒=锁定待 opt-in / ⬜=待办 / ✅=完成）

**设计阶段**
- ✅ D1 现状核验（模型/CRUD/校验/前端/enforcement 状态，§1）
- ✅ D2 工作台 IA + list-detail + 目标选择器 + 诚实标注设计（§3）
- ✅ D3 验收标准 + enforcement 出范围声明（§4/§5）
- ✅ D4 用户审阅 + §8 四项拍板（owner 2026-05-29）+ PATCH→PUT 修正 + 行号 re-grep @ `ca93e3a0b`

**实现阶段（全部 🔒，须显式 opt-in 才解锁；不在本次）**
- 🔒 T1 工作台 section 骨架（list-detail 壳复用）
- 🔒 T2 6 类目标数据源盘点 + 选择器接入
- 🔒 T3 scope 编辑器（subject/actions/targets 校验对齐后端）
- 🔒 T4 调用既有 4 路由打通增删改查
- 🔒 T5 §3.5 意图态说明条 + i18n（`tr()`）
- 🔒 T6 A2 wire-vs-fixture 往返集成测试
- 🔒 T7（独立、更后）enforcement 接线 = **另起 design-lock**，不属本链

## 8. 已拍板（owner 决策，2026-05-29）
1. **命名**：入口「考勤管理员工作台」，内部模块「排班管理范围」（或「排班范围登记」）。**暂不主打「排班权限」**——enforcement 未接线时"权限"易让用户误以为已运行时生效。→ 已落 标题 / G1 / §3.1。
2. **意图态说明条**：enforcement 未接线期间**保留明显说明**；接线后**降级**为小型状态标识 / 审计说明，不长期占大提示条。→ 已落 §3.5。
3. **首版 subject**：`user` / `role` / `role_tag` **本期全做**——后端已是三态真实 contract，UI 只做 user 会人为制造二期返工。→ 已落 §3.2 / §3.3。
4. **"无目标 = 全公司"**：**不做**；继续要求 ≥1 target。未来若要全公司，应**显式**新增"全公司"语义而非用空数组暗示（见 §6 R4）。

## 9. 参考
- 现状代码（@ `ca93e3a0b` / #2061）：`plugins/plugin-attendance/index.cjs`（`:48-49` 枚举 · `:7467-7534` normalize/match · `:26467` zod · CRUD `GET:26865/POST:26900/PUT:26951/DELETE:27015` · `:27264` summary）· `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts:90-112` · `apps/web/src/views/AttendanceView.vue:7235-7240`
- 动机：PR #2057（对标研究稿）§5
- 相关约束/惯例（repo 内可解析）：K3 PoC Stage-1 锁 + staged opt-in lineage + wire-vs-fixture drift trap 见 `CLAUDE.md`（Active constraints / Conventions）；list-detail 形态来源 = 考勤组 admin list-detail 链 PR #1946→#1965（`apps/web/src/views/AttendanceView.vue`）；TODO-checklist 🔒/⬜/✅ 格式见本文 §7。
