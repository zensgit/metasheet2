# 考勤组 ACL 写路径 O3 — 验证记录（2026-09-20）

> Design: `docs/development/attendance-group-acl-write-o3-design-20260920.md`  
> PR: draft（本文件随实现提交；命令结果在本地 vitest 跑完后回填）  
> 基准：`main` @ `123b1d1e5`（含 #5850 / `0708051ca`）  
> 证据：本地 vitest；合成 fixture；values-free。

## 1. Verdict

**PENDING local run** at first commit. Target: **PASS** for O3 member writes + roster read + preview, without regressing slice A list/get or employee overview.

Not a merge, deploy, or product-acceptance verdict.

## 2. What this PR claims

| 项 | 期望 |
|---|---|
| owner/sub_owner GET/POST/DELETE 本组 members | 200；SQL 含 managers + role 闭集 |
| 他组 / 非 manager 成员读写 | 403；不碰 `attendance_groups` / 不写 members |
| GET managers 本组 200 / 他组 403 先于 404 | POST/DELETE managers 仍 admin-only（OW8） |
| owner 固定班 preview | 200；无 assignment INSERT |
| 非 manager preview | 403；不跑组 SQL |
| owner PUT/DELETE 组、POST apply | 仍 403 |
| 缺 managers 表 | 503 |
| slice A list/get + 徽章 + 员工总览 | 不回归 |

## 3. Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts

pnpm --filter @metasheet/web exec vitest run --watch=false \
  AttendanceAdminTaskHome attendanceAdminTaskHomeStatus attendanceAdminTaskHomeAccess \
  attendance-web-guard-workflow AttendanceSetupReadiness.spec attendance-admin-anchor-nav \
  attendanceEmployeeWorkspacePresentation attendanceEmployeeWorkspaceCommonIcons \
  attendance-selfservice-dashboard
```

## 4. Results

（跑完后回填）

## 5. Adversarial / mutation

| 刀 | 预期 | 护栏 |
|---|---|---|
| 成员写路径去掉 `attendance_group_managers` 谓词 | 红 | owner 他组/非 manager 403 腿：断言无 `FROM attendance_groups`、无 members 写，且 SQL 含 managers + role 闭集 |
| 未知 action 当允许 | 红 | OW8 POST managers / PUT group / apply 仍 403 |
| GET :id/managers 先查 `attendance_groups` | 红 | 403 腿断言未出现 `FROM attendance_groups` |
| preview 对非 manager 放行 | 红 | scheduler-1 403 且无 `FROM attendance_groups` |

## 6. 未跑 / 残留

- 无浏览器（本切片后端 ACL + 诚实文案；picker 仍 admin，粘贴 userId）
- 无真库 PostgreSQL 集成
- 无 staging / 真实租户
- 组 CRUD、apply/rebuild/clear、`/api/attendance-admin/*` 仍不下放
