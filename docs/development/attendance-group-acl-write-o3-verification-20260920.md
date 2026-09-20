# 考勤组 ACL 写路径 O3 — 验证记录（2026-09-20）

> Design: `docs/development/attendance-group-acl-write-o3-design-20260920.md`  
> PR: draft `#5899` · branch `cursor/attendance-acl-write-o3-c9cb`  
> 基准：`main` @ `123b1d1e5`（含 #5850 / `0708051ca`）  
> 证据：本地 vitest；合成 fixture；values-free。

## 1. Verdict

**PASS** for the O3 write slice this PR claims: owner/sub_owner can list/add/remove members of managed groups, read the owner roster, and preview a fixed schedule. Group CRUD, manager promotion, and apply/rebuild/clear stay closed. Slice A list/get, task-home badges, and employee overview did not regress.

Not a merge, deploy, or product-acceptance verdict. Fresh exact-head CI on the draft PR is still required.

## 2. What was verified

| 项 | 结果 | 证据 |
|---|---|---|
| owner POST members 200 + values-free event | PASS | `attendance-uuid-validation-routes.test.ts` |
| owner GET/DELETE members | PASS | 同上；DELETE 带 `scope: managed` event |
| 非 manager / 他组成员读写 403 先于 404 | PASS | 无 `FROM attendance_groups`、无 members 写 |
| GET managers 本组 200；POST managers 仍 403（OW8） | PASS | 同一腿内 list 200 + write 403 |
| GET managers 他组 403 先于 404 | PASS | 无 `FROM attendance_groups` |
| owner 固定班 preview 200、无 apply 写 | PASS | 无 `INSERT INTO attendance_shift_assignments` |
| 非 manager preview 403 | PASS | 只碰 managers 谓词，不碰 `attendance_groups` |
| owner PUT/DELETE 组、POST apply 仍 403 | PASS | apply 仍 `SCHEDULER_SCOPE_FORBIDDEN` |
| 缺表 503（get + member write） | PASS | `DB_NOT_READY` |
| slice A list/get `scope=org/managed` | PASS | 既有腿仍绿 |
| TaskHome 徽章 + managed 过滤 + guard | PASS | 前端 10 files / 236 |
| setup-readiness「· incomplete」 | PASS | `AttendanceSetupReadiness.spec.ts` 30/30 |
| 员工总览四卡 / 常用 | PASS | presentation 18 + icons 3 + selfservice 85 |

## 3. Commands and results

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts
# Test Files  1 passed (1)
# Tests  101 passed (101)

pnpm --filter @metasheet/web exec vitest run --watch=false \
  AttendanceAdminTaskHome attendanceAdminTaskHomeStatus attendanceAdminTaskHomeAccess \
  attendance-web-guard-workflow AttendanceSetupReadiness.spec attendance-admin-anchor-nav \
  attendanceEmployeeWorkspacePresentation attendanceEmployeeWorkspaceCommonIcons \
  attendance-selfservice-dashboard
# Test Files  10 passed (10)
# Tests  236 passed (236)

pnpm --filter @metasheet/web exec vitest run --watch=false \
  AttendanceSetupReadiness.spec.ts attendanceEmployeeWorkspacePresentation.spec.ts
# Test Files  3 passed (3)  (includes useAttendanceSetupReadiness 26 + target 30 + 18)
# Tests  74 passed (74)
```

## 4. Adversarial / mutation

| 刀 | 预期 | 护栏 |
|---|---|---|
| 成员写路径去掉 `attendance_group_managers` 谓词 | 红 | owner 成功腿断言 SQL 含 managers + `role IN ('owner','sub_owner')`；非 manager 403 腿禁止 `FROM attendance_groups` / members 写 |
| GET members/managers 先查 `attendance_groups`（存在性泄露） | 红 | 403 腿 `not.toContain('FROM attendance_groups')` |
| POST managers 对 owner 放行 | 红 | OW8：list 200 后 POST 仍 403，无 INSERT |
| 未知 action / 组 CRUD / apply 当下放 | 红 | owner PUT/DELETE group 403；apply `SCHEDULER_SCOPE_FORBIDDEN` 且无 transaction |
| preview 对非 manager 放行 | 红 | scheduler-1 403 + 无 `FROM attendance_groups` |
| 缺表当允许 | 红 | member write 42P01 → 503，无 transaction |

## 5. 未跑 / 残留

- 无浏览器三视口（后端 ACL 合同；前端只改诚实文案）。
- 无真库 PostgreSQL 集成（与 slice A 同一 plugin unit harness）。
- 无 staging / 真实租户。
- `/api/attendance-admin/users/search` 与 batch-resolve 仍 admin：picker 会 403；粘贴 userId 可用；标签 fail-soft。
- 新建/复制/删除组按钮仍可见，点了后端 403。
- 固定班 apply/rebuild/clear/config、组织级规则/节假日/计薪仍不下放。

## 6. 口径

O3 最小写切片在本 draft PR 落地。#5850 的 list/get 与徽章不回退。不宣称组织级管理员能力已下放。
