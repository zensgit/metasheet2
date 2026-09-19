# 考勤管理首页遗留项设计：任务状态徽章 + 组内权限过滤（ACL slice A）

> **文档性质：实现设计（design lock for this PR）**  
> **日期**：2026-09-17  
> **基准**：`main` @ `89f1ecdee`  
> **议题谱系**：#4353 / #4354 / #4355（已关闭）；Wave 3 验证 MD 显式推迟两项；Harold 已确认本 backlog。  
> **草案来源**：on-demand 备料 `attendance-badges-groups-design-draft.md`（取证日 2026-09-17；未授权 runtime）。本文是该草案的入仓打磨版，并锁定本 PR 实际落地的切片。

---

## 0. 一句话结论

| 遗留项 | main 在本 PR 前 | 本 PR 是否落地 |
|---|---|---|
| (1) 管理首页 **per-task status badges** | **否**（组件无 status 字段/UI；setup-readiness「· 未完成」不是四态徽章） | **是**（四组徽章 + 未知态 fail-closed） |
| (2) **组内权限过滤** list/get（ACL slice A） | **否**（O1/O2 花名册已有；组 list/get 仍全局 `attendance:admin`） | **是**（服务端权威：fullAdmin 全量；owner/sub_owner 仅自己的组；非二者 403） |
| (3) O3 写路径拓宽 / section 能力矩阵刀 B | 未做 | **否（本 PR 明确不做）** |
| 员工总览四卡 + 首屏 polish | 已在 main | **否（本 PR 不重开）** |

不得把 O1/O2 负责人花名册或 setup-readiness「未完成」文案伪装成上述两项已完成。

---

## 1. 问题 / 目标 / 非目标

### 1.1 问题

关闭 #4353/#4354/#4355 后，Wave 3 验证记录诚实披露两项合法推迟：

1. **Per-task status badges**：管理中心任务首页四个任务组入口缺少章程 §4.2 规定的 readiness/status（未配置 / 需处理 / 正常 / 失败）。
2. **组内权限过滤**：章程 §6.2 将「section 权限过滤」留在父层；Wave 3 未实现按考勤组 owner/sub_owner 收敛可见入口与数据范围。管理面基本是「有 `attendance:admin` → 看见全组织全部入口与全部考勤组」。

### 1.2 目标

1. **徽章**：每个任务组标题行旁展示可审计的状态徽章；状态闭集；未知态 **不得** 映射为「正常」。
2. **组内过滤（slice A）**：在服务端权威边界上，使非全局考勤管理员仅能 **list/get** 其作为 `owner`/`sub_owner` 管理的考勤组；前端隐藏仅为体验。
3. **契约对齐**：`AttendanceAdminTaskHome.vue` 仍只做展示；徽章数据与权限过滤真源留在父层 / API。
4. **可验证**：正负向测试 + 承重 mutation（去掉过滤谓词或把未知态映射为 all-clear 必须变红）。

### 1.3 非目标

- 不重开考勤计算、审批语义、打卡策略、W4C/W6 核算链路。
- 不把 Wave 4 setup-readiness 七步向导改造成管理首页徽章系统（可复用信号，徽章是独立 UX 合同）。
- 不引入新的全局 RBAC 角色（如 `attendance_group_owner`）替代组边界。
- 不授权组负责人改组织级规则集 / 节假日 / 计薪模板。
- 不把员工总览四卡 / 首屏 polish 再开一轮。
- **不做 ACL 刀 B**：成员增删、固定班 apply、规则编辑、managers 读写仍 admin-only（OW8：防提权）。
- 不为填徽章而发明写路径或新的组织级聚合。

---

## 2. 当前 main 基线（实现前）

权威推迟声明：

- `docs/development/attendance-vnext-wave3-development-verification-20260721.md` §1：显式推迟 per-task status badges、组内权限过滤。
- 章程 `docs/development/attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md` §4.2 / §6.2。
- O3 作用域委托仍为 Deferred：`docs/development/attendance-group-admin-ux-owner-role-design-20260529.md`。

| 路径 | 实现前状态 |
|---|---|
| `AttendanceAdminTaskHome.vue` | 仅 title/detail/actions；无 status/badge |
| `AttendanceView.vue` `adminTaskHomeGroups` | 静态四组；setup-readiness 仅改一处 label |
| `GET /api/attendance/groups`、`GET /api/attendance/groups/:id` | `withPermission('attendance:admin')` + 整 org 全量 SQL |
| `userManagesAttendanceGroup` | 已有；已接线 `GET /api/attendance/team-availability` |
| O1/O2 managers 表与 admin CRUD | 已有；本 PR 不重做 |

---

## 3. 徽章合同

### 3.1 闭集

| 码 | 中文 | 英文 | 语义 |
|---|---|---|---|
| `not_configured` | 未配置 | Not configured | 关键前置配置缺失 |
| `needs_attention` | 需处理 | Needs attention | 有待办 / 异常 / 未完成准备 |
| `ok` | 正常 | OK | **已知**信号全部健康（必须有正向就绪证据） |
| `failed` | 失败 | Failed | 聚合 / 权限 / 接口失败 |
| `unknown` | 未知 | Unknown | 信号不足或未加载完（**默认**，fail-closed） |

**禁止**「无错误 ⇒ ok」。未知 / 缺字段 / 未识别码一律 `unknown`，不得显示「正常」文案或 ok 样式。

### 3.2 推导（首版）

纯模块：`apps/web/src/views/attendance/attendanceAdminTaskHomeStatus.ts`。  
父层 `AttendanceView.vue` 只把已有只读信号喂给纯模块；`AttendanceAdminTaskHome.vue` 只渲染 props。

| 任务组 | 信号源 | 首版规则 |
|---|---|---|
| `people-groups` | Wave 4 setup-readiness ①②③⑤（与「· 未完成」同一 gating 集，**不是**同一 UX 合同） | idle/loading → `unknown`；load error / 403 / `db_not_ready` → `failed`；gating 步存在且全部 `ready` → `ok`；存在 `missing` 且无失败 → `not_configured`；其余非 ready → `needs_attention`；空 steps → `unknown` |
| `daily-operations` | 无可靠只读异常/导入聚合挂在任务首页 | 长期允许 `unknown`（宁可未知，不可假绿） |
| `work-time-policies` | 无只读策略健康聚合 | `unknown` |
| `reporting-payroll` | 无只读报表/计薪健康聚合 | `unknown` |

setup-readiness 入口的「启用准备 · 未完成」label **保留**，不删除、不替代组级四态徽章。

### 3.3 UI

- 位置：每个 `attendance__admin-task-group` 标题行旁一枚徽章。
- DOM：`data-admin-task-status="<code>"`；文案走 `tr()`。
- 组件仍不 fetch。非法 / 缺省 status 在展示层再 fail-closed 一次（渲染 `unknown`，永不 `ok`）。

---

## 4. ACL slice A 合同

### 4.1 权限真源

1. **Full admin**：`hasAttendanceAdminAccess`（平台 admin 或 `attendance:admin`；`RBAC_BYPASS=true` 视为 full admin，与现测试 harness 一致）。
2. **Group manager**：`attendance_group_managers.role IN ('owner','sub_owner')`。
3. **助手**（对齐 O3 设计名，本 slice 只用于只读）：

```text
canManageAttendanceGroup(orgId, userId, groupId, action) → boolean
```

- 查库失败 / 缺表 → **拒绝**（503 `DB_NOT_READY`），永不默认允许。
- 未知 `action` → `false`。
- 首版 action 闭集：`view_group` | `list_members` | `view_team_availability` | `fixed_schedule_preview`。
- **本 PR 只把 `view_group` 接到 groups list/get。** 其余 action 入库是为了闭集与否认测试，不拓宽写路径。
- `list_members` / 固定班 apply / managers 写 / 规则编辑 → 仍 admin-only。

### 4.2 路由（刀 A）

**`GET /api/attendance/groups`**

| 调用方 | 结果 |
|---|---|
| full admin | 全量（现行为）+ `scope: 'org'` |
| 该 org 下至少一条 owner/sub_owner | 仅这些组；零行 → **200 空列表** + `scope: 'managed'` |
| 已登录但既非 admin 也非任何组 manager | **403** `FORBIDDEN` |
| 未登录 | **401** |
| managers 表缺失 | **503** `DB_NOT_READY` |

外层不再单独要求 `attendance:admin`：组负责人以 manager 行本身为授权（与「非全局管理员应能看见自己的组」一致）。`attendance:read` **不是**本 slice 的入场券——仅有 read、不是 manager 的人仍 403。

**`GET /api/attendance/groups/:id`**

- full admin：现行为（不存在 → 404）。
- 非 full admin：必须 `canManageAttendanceGroup(..., 'view_group')`，否则 **403 先于 404**（不泄露存在性）。
- 缺表 → 503。

**保持不变**

- `POST/PUT/DELETE /groups*`、members 写、managers 写：仍 `attendance:admin`。
- `GET /api/attendance/team-availability`：已有 admin **或** manager 模式，不改语义。

响应增量（list only，向后兼容）：`data.scope` ∈ `{ org, managed }`。前端用它区分空列表文案与任务首页过滤；**不能**当作安全边界。

### 4.3 前端（UX only）

纯模块：`apps/web/src/views/attendance/attendanceAdminTaskHomeAccess.ts`。

| viewer | 任务首页 | 考勤组工作台空态 |
|---|---|---|
| `org` / 尚未加载 | 四组全展示（避免 fullAdmin 首屏闪空） | 「暂无考勤组…」（现文案） |
| `managed` | 只保留 `people-groups`，且只留 `attendance-groups` + `team-availability`；不渲染导入/报表/组织级配置 | 「你不是任何考勤组的负责人」 |
| groups 403 且非 managed | 现 `adminForbidden` 空态 | — |

若 list 200 且 `scope=managed`，即使其它组织级 admin 端点 403，也不得用「全面无权限」空态盖住任务首页（`adminSurfaceBlocked`：`adminForbidden && scope !== 'managed'`）。隐藏 ≠ 授权。

---

## 5. 测试计划

### 5.1 徽章

1. TaskHome：四态 × 至少两组的 DOM / `data-admin-task-status`。
2. 未知 / 缺省 / 未识别码不得出现「正常」或 ok 样式。
3. Mutation：默认码或 unknown 解析改成 `ok` → 指定腿变红。
4. 回归：四组 key 顺序、深链 link emit、空 groups 仍绿；setup-readiness「· incomplete」腿仍绿。

### 5.2 组内过滤

1. 路由单元：fullAdmin 列全组；仅 manager 只列自己的组；无关用户 403。
2. `GET :id`：他组 403；本组 200；缺表 503。
3. Mutation：去掉 managers 谓词 → 列表腿变红。
4. Managers POST 仍拒绝非 admin（OW8）。
5. UI：`managed` 时 task home 不含未授权 section；空列表文案区分。

### 5.3 门禁

- 新 spec 进 `attendance-web-guard.yml` run-list + 双 path-filter。
- Backend 腿进既有 `attendance-uuid-validation-routes.test.ts`。
- values-free；无客户数据。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 假绿徽章 | 默认 `unknown`；正向证据才 `ok`；mutation |
| 前端过滤当安全 | 服务端 list/get fail-closed |
| 权限过宽 | 刀 A 只读；写路径仍 admin |
| 与 `attendance_scheduler_scopes` 混淆 | 助手只查 `attendance_group_managers` |
| AttendanceView 热文件膨胀 | 判别 / 过滤进纯 `.ts` |
| 空列表语义 | `scope` + 文案矩阵 |
| 范围漂移 | 刀 B / O3 全开另批 |

---

## 7. 显式声明

本文授权本 PR 的徽章 + ACL slice A。  
不授权刀 B 写路径、新全局角色、组织级配置下放、或员工总览再施工。
