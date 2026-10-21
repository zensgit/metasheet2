# 考勤组 ACL 写路径 O3：组负责人自管组（fail-closed）

> **文档性质：实现设计（design lock for this PR）**  
> **日期**：2026-09-20  
> **基准**：`main` @ `123b1d1e5`（含 #5850 / merge `0708051ca`：徽章 + ACL slice A list/get）  
> **谱系**：`attendance-group-admin-ux-owner-role-design-20260529.md`（O3 当时 Deferred）；`attendance-badges-groups-design-20260917.md`（slice A 明确不做写路径）  
> **本 PR**：设计 + 实现 + 验证；**draft，不合并**。

---

## 0. 一句话结论

| 项 | main 在本 PR 前 | 本 PR |
|---|---|---|
| Slice A list/get | fullAdmin `scope: org`；owner/sub_owner 仅托管组 `scope: managed`；get 403 先于 404 | **不改语义** |
| 成员 GET/POST/DELETE | `withAttendanceGroupMemberAccess`：仅 fullAdmin / `RBAC_BYPASS` | **owner/sub_owner 仅对自己的组** |
| 负责人花名册 GET | `attendance:admin` | **owner/sub_owner 只读本组花名册**（不写） |
| 负责人花名册 POST/DELETE | `attendance:admin`（OW8） | **仍 admin-only** |
| 固定班 preview | `fullAdmin` 才过 | **owner/sub_owner 可预览本组**（不写排班） |
| 组 CRUD / 规则 / 节假日 / 计薪 / apply·rebuild·clear | admin 或独立 scheduler-scope | **不下放** |

O3 **尚未**在 main 上落地。`canManageAttendanceGroup` 的 action 闭集已含 `list_members` / `fixed_schedule_preview`，但写路径与这两条路由都还没接线。

---

## 1. 目标 / 非目标

### 1.1 问题

Slice A 让组负责人看见自己的组，但 People 面板一打开就打：

- `GET /api/attendance/groups/:id/members` → 403
- `GET /api/attendance/groups/:id/managers` → 403

成员增删仍全局 `attendance:admin`。产品「组负责人自管组」在只读切片上停住。

### 1.2 目标

1. **fail-closed 下放最小写集**：`owner` / `sub_owner` 只能改 **自己管理的组** 的考勤人员。
2. **配套只读**：列出本组人员、只读本组负责人花名册、固定班 preview（slice A 已入库的 action）。
3. **403 先于 404**：非 fullAdmin 先查 `attendance_group_managers`，未命中则 403，不碰 `attendance_groups`（不泄露他组存在性）。
4. **复用** `userManagesAttendanceGroup` / `canManageAttendanceGroup`；未知 action → `false`。
5. **可验证**：正负向 + 承重 mutation（去掉 managers 谓词或把未知 action 当允许必须变红）。

### 1.3 非目标（硬）

除非另批证明已安全且产品需要，否则不做：

- 组织级规则集 / 节假日 / 计薪模板 / 导入 / 报表
- 无 admin 时提升/改写 `attendance_group_managers`（OW8）
- 改其他组，或 `POST/PUT/DELETE /api/attendance/groups`（创建/改 timezone·ruleSetId·类型/删组）
- 新全局 RBAC 角色
- 固定班 **apply / rebuild / clear / config**（写排班事实；已有独立 `attendance_scheduler_scopes`，不与组负责人混权）
- 下放 `/api/attendance-admin/*`（用户搜索 / batch resolve / 角色分配是组织目录，不是组边界）
- 重开员工总览四卡 / 徽章 / slice A list/get
- 新环境 flag

---

## 2. 当前 main 基线（#5850 之后）

权威路径：`plugins/plugin-attendance/index.cjs`。

| 能力 | 守卫 | 证据 |
|---|---|---|
| `userManagesAttendanceGroup` | `attendance_group_managers.role IN ('owner','sub_owner')` | ~25599 |
| `canManageAttendanceGroup` | 闭集：`view_group` \| `list_members` \| `view_team_availability` \| `fixed_schedule_preview`；未知 action → false | ~25613–25627 |
| `GET/GET :id /groups` | catalog / `view_group`；403 先于 404 | slice A |
| `GET/POST/DELETE .../members` | `withAttendanceGroupMemberAccess`：非 admin **直接 403**，不查 managers | ~26355–26400 |
| `GET/POST/DELETE .../managers` | `withPermission('attendance:admin')` | ~45438–45586 |
| `POST .../fixed-schedule/preview` | `!fullAdmin` → 403 | ~45754–45757 |
| apply/rebuild/clear/config | admin **或** scheduler-scope，**不是** group manager | ~26102+ |
| `GET .../team-availability` | admin 或 `userManagesAttendanceGroup` | ~48986–48990 |
| `/api/attendance-admin/users/search` | 路由级 `rbacGuard('attendance','admin')` | `attendance-admin.ts` |

前端：`scope=managed` 时任务首页只留 `people-groups` → `attendance-groups` + `team-availability`。选中组会立刻 `loadAttendanceGroupMembers` + `loadAttendanceGroupManagers`。成员写入已有「粘贴 userId」路径；picker 走 admin 目录，本切片不开放。

---

## 3. O3 权限矩阵

真源不变：

1. **Full admin**：`RBAC_BYPASS=true` 或 `hasAttendanceAdminAccess`（平台 admin / `attendance:admin`）。
2. **Group manager**：该 org + 该 `groupId` 上 `role IN ('owner','sub_owner')`。owner 与 sub_owner **同权**（本切片不拆）。
3. **助手**：`canManageAttendanceGroup(orgId, userId, groupId, action) → boolean`
   - 缺参 / 未知 action → `false`
   - 缺表 / 查库失败 → **拒绝**（503 `DB_NOT_READY`），永不默认允许

### 3.1 Action 闭集（本 PR 后）

| Action | 谁 | 接到的路由 |
|---|---|---|
| `view_group` | 已有 | `GET /groups`、`GET /groups/:id` |
| `list_members` | 已有，**本 PR 接线** | `GET /groups/:id/members` |
| `add_members` | **新增** | `POST /groups/:id/members` |
| `remove_members` | **新增** | `DELETE /groups/:id/members/:userId` |
| `list_managers` | **新增（只读）** | `GET /groups/:id/managers` |
| `view_team_availability` | 已有 | team-availability（不改） |
| `fixed_schedule_preview` | 已有，**本 PR 接线** | `POST /groups/:id/fixed-schedule/preview` |

**禁止**加入本闭集：`add_managers` / `remove_managers` / `update_group` / `delete_group` / `fixed_schedule_apply` / `fixed_schedule_rebuild` / `fixed_schedule_clear` / `edit_rules`。

### 3.2 端点 In / Out

**In（fullAdmin 保持现行为；manager 仅本组）**

| 方法 | 路径 | 非 admin 未管理 | 缺表 |
|---|---|---|---|
| GET | `/api/attendance/groups/:id/members` | 403 先于 404 | 503 |
| POST | `/api/attendance/groups/:id/members` | 403，不写 members | 503 |
| DELETE | `/api/attendance/groups/:id/members/:userId` | 403，不 DELETE | 503 |
| GET | `/api/attendance/groups/:id/managers` | 403 先于 404 | 503 |
| POST | `/api/attendance/groups/:id/fixed-schedule/preview` | 403，不跑 preview SQL | 503 |

**Out（仍 admin 或既有 scheduler-scope）**

- `POST/PUT/DELETE /api/attendance/groups`、`POST/DELETE .../managers`
- `PUT .../fixed-schedule/config`、`POST .../apply|rebuild|clear`
- 规则集 / 节假日 / 计薪 / 导入 / 报表 / `/api/attendance-admin/*`

未登录仍 401。伪造 `orgId` / `x-org-id` 仍走现有 actor 守卫（404/403），不因 O3 放宽。

### 3.3 委托写审计

成员 POST/DELETE 成功后 `emitEvent`，values-free：

```text
attendance.group.members.changed
{ orgId, groupId, actorId, action: 'add'|'remove', scope: 'org'|'managed', count? }
```

不含邮箱 / 姓名 / 主机。fullAdmin 与 manager 都发，用 `scope` 区分。

---

## 4. 实现要点

1. 扩展 `ATTENDANCE_GROUP_MANAGER_ACTIONS`；注释改为「O3 已下放的闭集，其余仍 admin」。
2. `withAttendanceGroupMemberAccess(action, handler)`：非 admin 时 `canManageAttendanceGroup(..., action)`，**先于** `assertAttendanceGroupInActorOrg`。
3. `GET .../managers`：去掉外层 `attendance:admin`，改为与 get-by-id 相同的 admin-or-`list_managers`；POST/DELETE 仍 `withPermission('attendance:admin')`。
4. preview：`fullAdmin` **或** `fixed_schedule_preview`；403 先于 `attendance_groups`。
5. 前端只改诚实文案（花名册仍 admin 写；成员自管已开）。不藏「新建/删除组」按钮——点了仍 403。picker 403 时仍可粘贴 userId。
6. 不改 OpenAPI 形状（已有 403）；不改徽章 / 员工总览。

---

## 5. 测试计划

进既有 `packages/core-backend/tests/unit/attendance-uuid-validation-routes.test.ts`，并改 gated source-scan `attendance-advanced-scheduling-scope.test.ts`：preview 锁 `canManageAttendanceGroup(..., 'fixed_schedule_preview')`（403 先于组探测 / preview SQL）；apply/rebuild/clear/config **禁止**出现该谓词，仍走 scheduler-scope assert（`pnpm --filter @metasheet/core-backend test` 会跑）。

| ID | 断言 |
|---|---|
| O3-1 | owner POST/DELETE/GET members：本组 200；SQL 含 `attendance_group_managers` + `role IN ('owner','sub_owner')` |
| O3-2 | 他组 / 非 manager：403；**无** `FROM attendance_groups`、无 members 写 |
| O3-3 | GET :id/managers：本组 200；他组 403 先于 404 |
| O3-4 | POST/DELETE managers 对 owner 仍 403（OW8） |
| O3-5 | owner PUT/DELETE `/groups/:id`、POST apply 仍 403 |
| O3-6 | owner preview 过门后才碰组；非 manager preview 403 且不跑 preview SQL |
| O3-7 | 缺 `attendance_group_managers` → 503 |
| O3-8 | slice A list/get + 员工总览既有腿仍绿 |
| MUT-1 | 去掉 members 写路径的 managers 谓词 → O3-2 红 |
| MUT-2 | 未知 action 当允许 → OW8 / apply 腿红 |

前端：既有 TaskHome / access / 员工总览回归；文案不进 DOM 合同。

---

## 6. 风险与残留

| 风险 | 缓解 |
|---|---|
| 成员写入改变考勤对象 | 仅本组；他组 403；mutation |
| 花名册 GET 当提权 | POST/DELETE 仍 admin |
| preview 当 apply | apply/rebuild/clear 不进闭集 |
| picker / batch-resolve 403 | 残留：粘贴 userId；标签 fail-soft（已有） |
| 新建/删组按钮仍可见 | 残留 UX；后端 403 |
| 与 scheduler-scope 混权 | 组负责人 ≠ 排班 scope；apply 仍走后者 |
| 假绿 | 403 先于 404；承重 mutation |

---

## 7. 显式声明

本文授权本 PR 的 O3 **最小写切片**（成员读写 + 花名册只读 + 固定班 preview）。  
不授权组 CRUD、负责人提权、组织级配置、排班 apply、admin 目录下放、新角色或员工总览再施工。
