# 审批委托 · C 委托体验增强（自助 + 审计可见）— 设计锁（design-lock）

> **状态**：design-lock（2026-07-03）+ 本 slice 实现随本次提交落地（未 push，评审后 PR）。
> **口径**：本文写 MetaSheet 自有设计口径（自助委托 / 审计可见 / 越权拒绝）。不引用任何竞品产品。审批模块**无 i18n 基础设施**——沿用既有硬编码中文（与 `DelegationSettingsView.vue` / `delegations.ts` 一致），本文记录此约定。
> **基线**：代码实测 @ `origin/main`（worktree `metasheet2-cdeleg`）。
> **承重前提**：委托**运行时已 SHIPPED**——resolve-time 冻结代换语义（frozen-at-start）**不改**。本 slice 只加运行时之上的**治理/体验层**：自助 + 审计可见，**不新建委托引擎**。

---

## 0. 一句话

委托运行时（引擎）已完成；本 slice 补两个真实缺口——**普通用户自助管理自己的委托** + **管理员审计可见（含历史 + 有效期 + 经委托路由的审批数）**——并只在确有未防护缺口处加边界守卫。

---

## 1. 已 SHIPPED 的委托面（勿重建）

代码实证（`origin/main`）：

| 层 | 文件 | 已有能力 |
|---|---|---|
| 读种子（resolve 冻结） | `packages/core-backend/src/services/ApprovalDelegations.ts` | `resolveActiveDelegationMap(query, {templateId, now})` → 冻结 `delegator→delegatee` 代换 map；只 SELECT、不写；template scope 覆盖 all scope；无 self 边（表 CHECK）。 |
| 配置 CRUD（写路径） | `packages/core-backend/src/services/ApprovalDelegationConfig.ts` | `createDelegation` / `listDelegations`（**仅 `WHERE active`**）/ `disableDelegation` / `updateDelegation`。`delegatorUserId` 是**任意可选字段**（管理员为任意人配置）。enum-strict 校验 + 表 CHECK 双保险；唯一活跃索引 → 同 (delegator, scope target) 二条活跃 = 409。 |
| 路由 | `packages/core-backend/src/routes/approvals.ts` L800-857 | `GET/POST/PATCH/DELETE /api/approval-delegations` **全部** `approvalTemplateAdminGuard`（`rbacGuardAny(['approval-templates:manage','approvals:admin-templates'])`）——**100% 管理员专属**。 |
| 前端 client | `apps/web/src/approvals/delegations.ts` | list/create/update/disable + 表单校验（中文）+ `buildCreatePayload`；create payload **携带 `delegatorUserId`**（管理员语义）。 |
| 前端视图 | `apps/web/src/views/approval/DelegationSettingsView.vue`（route `/approval-delegations`，`permissions: ['approval-templates:manage']`） | 委托设置表格 + 新建对话框；**仅列活跃**。 |
| resolve 代换 | `ApprovalAssigneeResolver.ts` `pushResolved` | 代换在 dedup key 前发生；**单跳**（delegatee 自己的委托不再解析，L111）；user-only；被代换的 assignment 带 `metadata.delegatedFrom = <原 delegator>`（审计痕迹）。 |
| 代换审计痕迹落库 | `ApprovalProductService.insertAssignments` | `metadata`（含 `delegatedFrom`）JSONB 落入 `approval_assignments.metadata` → **「经委托路由」DB 可派生**（`metadata->>'delegatedFrom'`）。 |
| 迁移 | `zzzz20260622060000_create_approval_delegations.ts` | 表 + window/not-self/scope/scope-target 4 个 CHECK + 唯一活跃索引 + 查询索引。 |

---

## 2. 缺口界定（EXACTLY 本 slice 填什么 / 什么已 SHIPPED）

| 需求 | 现状 | 结论 |
|---|---|---|
| **自助**：用户设/撤自己的委托 | 路由 100% 管理员 guard；用户无路径。 | **真缺口 → 建**。 |
| **审计/有效期可见** | `listDelegations` 只 `WHERE active`——历史（停用/过期）永不返回；无「经委托路由」读路径（数据在 assignment metadata 但无查询）。 | **真缺口 → 建**（含历史 + routed 数）。 |
| 边界：self 委托（delegator==delegatee） | service 校验 + 表 CHECK 双防护。 | **已防护 → 仅记录**，不重建。 |
| 边界：时间窗重叠调度 | 迁移注释明写「一 scope target 一条活跃」= 唯一活跃索引；多窗调度是 reopen-only。 | **设计既定 → 不加**。 |
| 边界：委托链 A→B→C | resolver **单跳**（L111 明写 delegatee 自己的委托不再解析）。 | **已防护（冻结语义）→ 仅记录**。 |

---

## 3. 本 slice 设计锁（只新增 2 个边界）

本 slice 只引入两条新边界；resolve 语义不动。

### 3.1 自助（delegator = 自己，结构性强制）
- 新增 `authenticate` + `rbacGuard('approvals','read')`（审批参与者底线，与 `/pending` 同）自助路由：
  - `GET  /api/approval-delegations/mine` — 列**自己的**委托（活跃 + 历史），附 routed 数。
  - `POST /api/approval-delegations/mine` — 建自己的委托；**`delegator_user_id` 服务端强制 = actor id，绝不读 body 的 `delegatorUserId`**（越权是结构性不可能，而非可回归的校验）。
  - `DELETE /api/approval-delegations/mine/:id` — 停用自己的委托。
- **无自助 PATCH**：「设/撤」= 建 + 停用；admin 路径里 delegator 本就不可改。
- **权限口径**：自助授权的承重点是**归属校验**（delegator 强制 = actor + 停用前归属检查），RBAC 层只是「是不是审批用户」的底线；故 `approvals:read`。前端 route 仅 `requiresAuth`。

### 3.2 越权停用 = 403 而非 404（SELECT-then-check 判别器）
- `DELETE /mine/:id`：**先 SELECT**——不存在 → 404；存在但 `delegator_user_id ≠ actor` → **403**；否则停用 → 200。
- 承重：一个 scoped `UPDATE ... WHERE id AND delegator=actor` 对「别人的行」返回 0 行 → 会误报 404，**破坏 VERIFY 要求的 403**。故 service 返回判别联合 `{status:'not_found'|'forbidden'|'ok'}`，路由映射状态码。

### 3.3 审计可见（复用既有查询 + 派生）
- 扩 `listDelegations(query, { delegatorUserId?, includeInactive? })`：`includeInactive` 时不加 `WHERE active`（管理员审计历史）；默认行为不变（活跃 only，向后兼容）。
- 扩 `GET /api/approval-delegations` 接受 `?includeInactive=true`。
- `routedApprovalCount`（该 delegator 名下经委托路由的**去重 instance 数**）派生自 `SELECT metadata->>'delegatedFrom' AS delegator, COUNT(DISTINCT instance_id) FROM approval_assignments WHERE metadata->>'delegatedFrom' IS NOT NULL GROUP BY 1`。
- **热路径纪律（性能）**：该聚合是对 `approval_assignments`（增长最快的审批表）的 hash aggregate，且 `delegatedFrom` **无表达式索引** → 仅在 **audit 模式（`includeInactive=true`）** 计算并附加；默认「活跃/运营」视图**不付**该聚合、保持单条小查询（避免在最常用的默认视图上引入 seq-scan 回归）。FE「已路由审批」列亦仅在 audit（显示历史）模式渲染——默认视图**不显示**该列（避免误导性 0）。
- **粒度诚实声明**：assignment metadata 只记 `delegatedFrom = delegator id`，**不记具体委托窗行**；故 routed 数是**按 delegator 聚合**（同 delegator 各行显示同一总数），非按单条委托窗。文档 + FE tooltip 明写此口径。

### 3.4 前端（1 新视图 + 1 扩展视图）
- 新 `MyDelegationView.vue`（route `/my-delegation`，仅 `requiresAuth`，任意登录用户）：我的委托——设/撤自己的（只填被委托人 + 范围 + 时间窗，委托人隐含=自己）+ 列自己的活跃 + 历史 + routed 数。
- 扩 `DelegationSettingsView.vue`：加「显示历史」开关（`includeInactive`）；「已路由审批」列**仅在开关打开（audit 模式）时渲染**（默认运营视图不显示、不触发聚合）。**不建第二个审计视图**。

---

## 4. 验证计划（fail-first / real-DB）

DB：`metasheet_cdeleg_test`（`CREATE DATABASE` → `migrate.ts` → `vitest.integration.config.ts`）。

- **RED-before**：`/mine` 路由在 `origin/main` 不存在 → 自助测试初跑 404（红），实现后转绿。
- 后端 real-DB（新 `approval-delegation-selfservice.db.test.ts`）：
  1. 自助 actor 建自己的委托（即便 body 塞别人的 `delegatorUserId` 也强制 = actor）→ 201 且 delegator = actor。
  2. 自助 actor 列自己的（含一条已停用的历史）。
  3. 自助 actor 停用**自己的** → 200。
  4. 自助 actor 停用**别人的** → **403**（判别器）。
  5. 自助 actor 停用不存在的 → 404。
- 后端 real-DB（扩既有 `approval-delegation-api.db.test.ts`）：
  6. 管理员 `?includeInactive=true` 见到已停用行（历史）。
  7. routed 数：扩既有「建委托 → 起审批 → assignment 解析到 delegatee」e2e，断言管理员审计 `routedApprovalCount ≥ 1` 且反映真实 resolver 输出（**真 resolver 输出，非手插 metadata fixture** — 遵 wire-vs-fixture-drift 规则；去重 instance 计数）。
- 后端 unit（扩 `approval-delegation-config.test.ts`，fake query）：`includeInactive` SQL 分支 + `disableOwnDelegation` 判别联合三态。
- 前端：`MyDelegationView` 渲染 + own 表单校验 + 扩展 admin 视图历史开关；`vue-tsc -b` 0 + `vitest`。
- 回归：既有委托测试仍绿；后端 `tsc --noEmit` 0。

---

## 5. 不做（reopen-only）
- 多窗重叠调度 / 委托链多跳 / 修改 resolve 冻结语义 / self-service PATCH / 逐委托窗的精确 routed 归因（需 metadata 增列，非本 slice）。
