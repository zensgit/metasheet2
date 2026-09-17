# 考勤任务徽章 + 组内 ACL slice A — 验证记录（2026-09-17）

> Design: `docs/development/attendance-badges-groups-design-20260917.md`  
> PR: draft `#5850` · branch `cursor/attendance-badges-groups-acl-96e7`  
> 基准：`main` @ `89f1ecdee`  
> 证据：本地 vitest；合成 fixture；values-free。

## 1. Verdict

**PASS** for the leftover pair this PR claims: per-task status badges + groups list/get owner/sub_owner scoping.

Not a merge, deploy, or product-acceptance verdict. Fresh exact-head CI on the draft PR is still required.

## 2. What was verified

| 项 | 结果 | 证据 |
|---|---|---|
| TaskHome 四态徽章 DOM | PASS | `AttendanceAdminTaskHome.spec.ts` 9/9（含四态矩阵 + 缺省/未识别码不得 OK） |
| 未知态 fail-closed 纯模块 | PASS | `attendanceAdminTaskHomeStatus.spec.ts` 4/4；默认码 `unknown`，`ready`/`success`/空值 → `unknown` |
| people-groups 信号（setup-readiness ①②③⑤） | PASS | 同上：idle/loading=`unknown`；error/403/db_not_ready=`failed`；gating 全 ready=`ok`；groups missing=`not_configured` |
| 无可靠信号组不假绿 | PASS | daily-operations / work-time-policies / reporting-payroll 在 people-groups 已 ok 时仍为 `unknown` |
| managed 任务首页过滤 | PASS | `attendanceAdminTaskHomeAccess.spec.ts` 4/4；只留 people-groups → 考勤组/可用性 |
| 空列表文案区分 | PASS | managed ≠ org「暂无考勤组」 |
| setup-readiness「· incomplete」未破坏 | PASS | `AttendanceSetupReadiness.spec.ts` 30/30（含既有 label 腿） |
| 四组顺序 / 深链 / 空 groups | PASS | TaskHome 9/9 + `attendance-admin-anchor-nav.spec.ts` 32/32 |
| Guard 接线 | PASS | `attendance-web-guard-workflow.spec.ts` 25/25（新 spec 双 path-filter + run-list） |
| fullAdmin 列全组 `scope=org` | PASS | `attendance-uuid-validation-routes.test.ts` |
| manager 只列自己的组 `scope=managed` | PASS | 同上；SQL 含 `attendance_group_managers` + `role IN ('owner','sub_owner')` |
| 非 admin 非 manager 403 | PASS | 同上；未碰 `attendance_groups` |
| GET :id 本组 200 / 他组 403 先于 404 | PASS | 同上 |
| 缺表 503 | PASS | 同上 |
| Managers POST 仍 admin-only | PASS | 既有 OW8 腿仍绿 |
| 员工总览四卡 / 常用 | PASS | `attendanceEmployeeWorkspacePresentation` 18/18；`attendanceEmployeeWorkspaceCommonIcons` 3/3；`attendance-selfservice-dashboard` 85/85（合计 106/106）— 本 PR 未改这些文件 |

## 3. Commands and results

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  AttendanceAdminTaskHome attendanceAdminTaskHomeStatus attendanceAdminTaskHomeAccess \
  attendance-web-guard-workflow AttendanceSetupReadiness.spec attendance-admin-anchor-nav
# Test Files  7 passed (7)
# Tests  130 passed (130)

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts
# Test Files  1 passed (1)
# Tests  93 passed (93)

pnpm --filter @metasheet/web exec vitest run --watch=false \
  attendanceEmployeeWorkspacePresentation attendanceEmployeeWorkspaceCommonIcons \
  attendance-selfservice-dashboard
# Test Files  3 passed (3)
# Tests  106 passed (106)
```

首轮 manager list 腿曾红（500）：mock 把 list SQL 里的 `SELECT group_id`（member_counts 子查询）误判成 catalog probe。收窄谓词后 93/93 绿。该 mock 收窄本身也防止「去掉 managers JOIN 仍绿」。

## 4. Adversarial / mutation

| 刀 | 预期 | 护栏 |
|---|---|---|
| `DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS` 改为 `ok` | 红 | `attendanceAdminTaskHomeStatus.spec.ts`：`expect(DEFAULT...).toBe('unknown')` 且 `.not.toBe('ok')` |
| `resolveAttendanceAdminTaskHomeStatus` 把未识别码映射为 `ok` | 红 | `ready` / `success` / `undefined` 必须是 `unknown` |
| TaskHome 缺省 status 渲染 OK / ok class | 红 | `AttendanceAdminTaskHome.spec.ts` 负向腿 |
| 去掉 list SQL 的 `attendance_group_managers` 谓词 | 红 | manager list 腿断言 SQL 含 managers + role 闭集；且 catalog probe 与 list SQL 已拆开 |
| 非 manager GET :id 先查 `attendance_groups`（存在性泄露） | 红 | 403 腿断言未出现 `FROM attendance_groups` |
| Managers POST 对非 admin 放行 | 红 | 既有 OW8 腿 |

## 5. 未跑 / 已知项

- 无浏览器三视口（TaskHome 徽章为 DOM/class 合同；布局由既有 Wave 3 栅格承担）。
- 无真库 PostgreSQL 集成（本 slice 走既有 plugin unit harness，与 team-availability manager 腿同一层）。
- 无 staging / 真实租户。
- ACL 刀 B（成员写、固定班 apply、section 全矩阵）仍不做。
- `daily-operations` / `work-time-policies` / `reporting-payroll` 徽章首版长期 `unknown`（设计已写：宁可未知，不可假绿）。

## 6. 口径

两项 Wave 3 leftovers 在本 draft PR 落地。员工总览四卡 / 首屏不在本 diff。O1/O2 花名册与「启用准备 · 未完成」label 均保留，不是徽章或 slice A 的替代。
