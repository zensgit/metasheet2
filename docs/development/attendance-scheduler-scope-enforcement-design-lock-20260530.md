# 考勤排班管理范围 enforcement design-lock（仅设计 / 不写码）

> Date: 2026-05-30 · Author: Codex · Status: **DESIGN-LOCK - 设计冻结，待显式 opt-in 才实现，不含任何代码**
> 证据基准：下文 `file:line` 为 re-grep-verified @ origin/main `6e5e3d032`（#2129，T4 target pickers 已落地）的快照。symbol 名为稳定锚，行号为该 SHA 快照；若实现期 main 继续推进，先 rebase 并重新 re-grep 漂移行号。
> 上游设计：`docs/development/attendance-scheduler-scope-workbench-design-lock-20260529.md` 明确把 enforcement 接线列为独立 T7。本稿只锁 T7 设计，不修改运行时代码。

## 0. Hard constraints

- **仅设计、不开工、不写码**：本文是交付物；任何代码实现必须另起 opt-in。
- **不改中央 RBAC / auth / integration-core**：只在 `plugin-attendance` 内做本地 route guard 设计。
- **不新增权限模型**：复用已落地的 subject (`user` / `role` / `role_tag`) × actions × 6 类 scope target。
- **不做 big-bang enforcement**：第一刀只接 target 明确、可测、可回滚的排班写路径；导入、审批、报表、薪资、清空、完整读过滤都出范围。
- **不改变全量 admin 的既有能力**：`isAdmin` / `attendance:admin` 仍是 full-admin bypass；scope enforcement 只给非 full-admin 的 scoped actor 开窄口，且只在明确路由生效。

## 1. Current state @ `6e5e3d032`

T1-T4 已经把工作台从只读推进到 CRUD + target pickers；runtime enforcement 仍未接线。

| Area | Current state | Evidence |
|---|---|---|
| Workbench UI | 列表、新建、编辑、停用、6 target pickers 已落地；顶部仍诚实说明未运行时强制 | `apps/web/src/views/AttendanceView.vue:1297-1567` |
| Form payload | create / update 继续严格发 6 键 `scope`，`orgId` 走 query | `apps/web/src/views/AttendanceView.vue:19172-19260` |
| CRUD backend | `GET/POST/PUT/DELETE /api/attendance/scheduler-scopes`，body `.strict()` | `plugins/plugin-attendance/index.cjs:27114-27127` · `:27521-27671` |
| Match helper | `attendanceSchedulerScopeMatchesTarget(scopeRow, target)` 已按 6 类目标判定覆盖 | `plugins/plugin-attendance/index.cjs:7611-7628` |
| Helper export/tests | helper 暴露给测试；已有 unit 覆盖目标覆盖与空 scope fail-closed | `plugins/plugin-attendance/index.cjs:15134` · `packages/core-backend/tests/unit/attendance-advanced-scheduling-scope.test.ts:126-169` |
| RBAC helpers | `hasAttendanceAdminAccess` / `withPermission('attendance:admin')` / `canAccessOtherUsers` 已存在 | `plugins/plugin-attendance/index.cjs:14689-14704` |
| Actor context | 可解析 actor 的 roles / roleTags / attendanceGroups | `plugins/plugin-attendance/index.cjs:11733-11820` |

关键事实：`attendanceSchedulerScopeMatchesTarget` 目前仍只有定义、export、测试，没有任何业务路由调用。scope 现在是“可登记、可展示、可维护”的管理意图，还不是 runtime boundary。

## 2. Design goal

把 scheduler scope 从“登记意图”推进到“对特定排班写路径的运行时边界”，但先只接一条清晰路径：

- G1 允许 full admin 维持现状，不受 scope 限制。
- G2 允许拥有匹配 active scheduler scope 的非 full-admin actor，在明确 target 内执行第一刀排班写动作。
- G3 对未覆盖 target/action 的 scoped actor 返回 403，不静默放行。
- G4 每个接线 route 都必须有真实 wire 测试证明 helper 被调用，而不是只测 helper 本身。
- G5 UI 文案只在已接线能力上降级“未生效”提示；不得暗示所有 scheduler scope 都已全局生效。

## 3. Enforcement composition

`attendanceSchedulerScopeMatchesTarget` 只能回答“scope 的 6 类目标是否覆盖 target”。真正 enforcement 必须显式组合四件事：

| Layer | Responsibility | First-slice rule |
|---|---|---|
| Actor | 从 `req` 取 `userId`，加载 actor roles / roleTags | 用 `getUserId(req)` + `loadAttendanceScopeContextForUser` |
| Subject | 找到 actor 可用的 active scopes | `subject_type=user` 精确匹配 actor userId；`role` / `role_tag` 精确匹配 actor context |
| Action | route 声明自己要的 action | E1 只用 `dispatch` |
| Target | route resolver 生成 6 键 target 的相关子集 | E1 必须至少包含 `scheduleGroupIds`，POST 还必须包含 `userIds` |

### 3.1 Local guard shape

实现期建议新增 attendance-local helper，而不是改中央 RBAC：

```text
assertAttendanceSchedulerScopeAllowed(req, {
  action,
  target,
  mode: 'allow-full-admin-or-matching-scope',
})
```

规则：

- 如果 actor 是 `isAdmin` 或有 `attendance:admin`，直接放行，保持现有行为。
- 否则加载 actor active scheduler scopes；仅当 subject 匹配、`actions` 包含 route action、且 `attendanceSchedulerScopeMatchesTarget(scope, target)` 为 true 时放行。
- 无匹配则返回 403，错误码固定为 `SCHEDULER_SCOPE_FORBIDDEN`。
- 未登录 / 无 actor 仍按现有 auth 行为拒绝。
- helper 只放在 `plugin-attendance` 内，不进入中央 RBAC。

实现集成点必须是 route guard 本身或 guard 前置 wrapper，不能只是把 assert 加到现有 `withPermission('attendance:admin')` 后面；否则 non-admin scoped actor 会先被旧 guard 拦下，永远到不了 scope 判定。E1 routes 因此需要把当前 admin-only guard 替换为 attendance-local guard：full admin bypass，非 full-admin 继续走 scope target 判定。

### 3.2 Important semantic trap

`scopeListCoversTarget` 对“target list 为空”返回 true（`index.cjs:7611-7616`）。这代表 route resolver **不能省略关键 target 维度**，否则会把“未检查”误当成“已覆盖”。

因此：

- E1 POST schedule group member 必须传 `scheduleGroupIds: [groupId]` 和 `userIds: input.userIds`。
- E1 DELETE schedule group member 必须先查 existing member，再传 `scheduleGroupIds: [groupId]` 和 `userIds: [existing.user_id]`。
- 任何无法可靠解析 target 的写 route，本阶段不得接 enforcement。
- 对 scoped actor，如果 resolver 预期 target 但解析失败，fail closed 为 403；full admin 保持原行为。

## 4. First slice E1: schedule group member dispatch only

第一刀只接“排班组成员分派/移除”，原因是 target 最清楚，且不需要重新定义“班次/轮班规则本身属于哪个范围”。

| Route | Current guard | E1 action | Target resolver | E1 decision |
|---|---|---|---|---|
| `POST /api/attendance/schedule-groups/:id/members` | `withPermission('attendance:admin')` | `dispatch` | path `:id` -> `scheduleGroupIds`; body `userId/userIds` -> `userIds` | ✅ 接线 |
| `DELETE /api/attendance/schedule-groups/:id/members/:memberId` | `withPermission('attendance:admin')` | `dispatch` | path `:id` -> `scheduleGroupIds`; DB existing member -> `userIds` | ✅ 接线 |
| `GET /api/attendance/schedule-groups/:id/members` | `withPermission('attendance:admin')` | `view` | 需要读过滤与分页语义 | ⬜ 后续 |
| `POST/PUT/DELETE /api/attendance/schedule-groups` | `withPermission('attendance:admin')` | `edit` | create 没有 pre-insert group id，update/delete 还需定义 group metadata target | ⬜ 后续 |
| `POST/PUT/DELETE /api/attendance/assignments` | `withPermission('attendance:admin')` | `dispatch` | 只有 user/shift/date，需 date-aware schedule group resolver | ⬜ 后续 |
| `POST/PUT/DELETE /api/attendance/rotation-assignments` | `withPermission('attendance:admin')` | `dispatch` | 只有 user/rotation/date，需 date-aware schedule group resolver | ⬜ 后续 |

### 4.1 Why not assignment routes first

`/api/attendance/assignments` 与 `/api/attendance/rotation-assignments` 只有 user、shift/rotation、date range；当前 payload 不带 `scheduleGroupId`。若直接只用 `userIds` 判定，会让“按排班组授权”的 scope 无法发挥作用；若省略 `scheduleGroupIds`，又会踩 §3.2 的空 target trap。

这些 route 应在 E2 增加 target resolver 后再接：

- 根据 user + date range 解析 active schedule group membership。
- 或者明确承认 assignment dispatch 第一版只支持 `userIds` scope，不支持 schedule group scope。该取舍需要独立拍板。

## 5. Auth behavior lock

E1 是“本地 scoped access”，不是中央 RBAC 变更。

| Actor | Existing behavior | E1 behavior |
|---|---|---|
| `isAdmin` | 可访问 admin route | 不变，直接 bypass scope |
| `attendance:admin` | 可访问 admin route | 不变，直接 bypass scope |
| non-admin + matching active scheduler scope | 现在被 `withPermission('attendance:admin')` 拦住 | 仅在 E1 routes + matching action/target 上放行 |
| non-admin + no matching scope | 被拦住 | 403 `SCHEDULER_SCOPE_FORBIDDEN` |

实现期不能把 scheduler scope 写入中央 role/permission 表，也不能新增 `attendance:scheduler-scope` 这类 global permission。scope 本身就是局部能力边界。

## 6. UI implication

当前 workbench 说明条仍然正确：scope 尚未全局运行时强制。

E1 合入后，说明条只能改成更精确的有限状态，例如：

> Runtime enforcement is enabled for schedule group member dispatch only; other actions remain administrative registry entries.

中文：

> 已对“排班组成员分派/移除”启用运行时范围校验；其他动作仍为管理登记，待后续接线。

不要使用“排班权限已生效”这类全局化措辞，直到 read/write/import/approve 等路径均完成或按模块明确标注。

## 7. Tests and acceptance

E1 实现必须先补测试，再接 route。

| ID | Acceptance |
|---|---|
| A1 | full admin 调用 E1 POST/DELETE 仍保持现有成功路径，不需要 scope |
| A2 | non-admin + `subjectType=user` + `actions:['dispatch']` + matching `scheduleGroupIds/userIds` 可以 POST 成员 |
| A3 | non-admin + scope 覆盖 schedule group 但不覆盖 user，POST 返回 403 |
| A4 | non-admin + scope 覆盖 user 但不覆盖 schedule group，POST 返回 403 |
| A5 | DELETE 先解析 existing member，匹配 scope 才删除；不匹配不删除且返回 403 |
| A6 | 无 active scope / action 缺 `dispatch` / inactive scope 均返回 403 |
| A7 | route-level test spy 或 observable side effect 证明 `attendanceSchedulerScopeMatchesTarget` 参与了真实请求路径 |
| A8 | resolver 失败或 member lookup 无法形成 target 时，scoped actor fail closed；full admin 保持既有 NOT_FOUND / validation 行为 |

建议测试位置：

- unit/helper：继续放在 `packages/core-backend/tests/unit/attendance-advanced-scheduling-scope.test.ts`，覆盖 subject/action/target composition。
- route/integration：放 attendance scheduling route suite，使用真实 HTTP request，验证 403 不写库。

## 8. Later phases (out of E1)

- E2 assignment dispatch resolver：为 shift / rotation assignment 建立 user + date range -> schedule group target resolver。
- E3 schedule group CRUD edit：定义 schedule group create/update/delete 的 target 语义，尤其 create 没有 pre-insert id。
- E4 read/list filtering：给 scoped actor 返回过滤后的 groups/members/assignments，而不是全量 admin list。
- E5 import/export/clear/approve：单独 design-lock，因为会碰导入流、审批、报表/薪资边界。
- E6 UI delegated mode：只有 read/filter 和写 enforcement 都具备后，才把工作台对非 full-admin actor 可见。

## 9. Gated TODO

**设计阶段**

- ✅ D1 re-grep 当前 T4 后基线：helper、RBAC、scope CRUD、workbench UI、member routes。
- ✅ D2 锁定 E1 不做 big-bang，只接 schedule group member dispatch。
- ✅ D3 记录空 target trap，要求 route resolver 不得省略关键 target 维度。
- ✅ D4 明确 full admin bypass、non-admin scoped allow 的本地 guard 语义。

**实现阶段（全部 🔒，须显式 opt-in）**

- 🔒 E1-T1 新增 attendance-local guard/helper，不改中央 RBAC。
- 🔒 E1-T2 实现 actor subject scope 加载：user/role/role_tag 三态。
- 🔒 E1-T3 接 `POST /api/attendance/schedule-groups/:id/members`。
- 🔒 E1-T4 接 `DELETE /api/attendance/schedule-groups/:id/members/:memberId`。
- 🔒 E1-T5 补 A1-A8 测试，证明真实 route 调用了 match helper 且 403 不写库。
- 🔒 E1-T6 只在 E1 能力范围内调整 UI 说明条。

## 10. Owner decisions before implementation

1. **E1 route scope**：是否认可第一刀只接 schedule group member POST/DELETE，不碰 assignments/import/approval？
2. **Scoped actor behavior**：是否认可 non-admin 在 E1 route 上可被 matching scheduler scope 放行，而 full admin bypass 保持不变？
3. **Mismatch error**：是否统一用 403 `SCHEDULER_SCOPE_FORBIDDEN`，而不是伪装 404？
4. **Assignment resolver**：是否接受 assignment / rotation assignment 先留 E2，等 user+date -> schedule group resolver 设计清楚再接？

## 11. References

- Workbench upstream design-lock: `docs/development/attendance-scheduler-scope-workbench-design-lock-20260529.md`
- T4 frontend landing: `apps/web/src/views/AttendanceView.vue:1297-1567` and `:19172-19337`
- Backend scheduler-scope helper: `plugins/plugin-attendance/index.cjs:7611-7628`
- Existing RBAC helpers: `plugins/plugin-attendance/index.cjs:14689-14704`
- Actor scope context: `plugins/plugin-attendance/index.cjs:11733-11820`
- E1 candidate routes: `plugins/plugin-attendance/index.cjs:27365-27483`
- Assignment routes deferred to E2: `plugins/plugin-attendance/index.cjs:20637-20905` and `:28297-28577`
