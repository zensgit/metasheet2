# 考勤 Period Rollup PR3 验证记录

Date: 2026-05-19

## Summary

本轮验证覆盖周期汇总同步入口的前端行为：date range、payroll cycle、single user、userIds、all users pagination、成功结果、degraded warning、API error。PR3 合并并部署到 staging 后已补真实 live evidence，见 `docs/development/attendance-report-period-rollup-sync-live-closeout-verification-20260519.md`。

## Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts --watch=false
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build
git diff --check
```

结果：

```text
PASS tests/AttendanceReportFieldsSection.spec.ts
26 tests passed

PASS tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts
37 tests passed

vue-tsc -b PASS
plugin syntax PASS
web build PASS
core-backend build PASS
git diff --check PASS
```

## Coverage

| Area | Evidence |
| --- | --- |
| date range + single user | 请求 `POST /api/attendance/report-period-summaries/sync?orgId=org-1`，body 为 `{ from, to, userId }` |
| payroll cycle + userIds | body 为 `{ cycleId, userIds: [...] }`，不发送 `from/to` |
| all users pagination | body 为 `{ from, to, allUsers:true, page, pageSize }` |
| success display | 展示 `periodType`、`fieldFingerprint`、`syncedAt`、`attendance_report_period_summaries` object id |
| multitable link | 生成 `/multitable/sheet-period/view-period?baseId=base-period` |
| degraded | `degraded:true` 显示 warn，保留页面 |
| error | HTTP 400 / `ok:false` 显示 error，保留页面 |

## Live Evidence

- Staging live evidence: completed after PR3 was merged and deployed to staging. See `docs/development/attendance-report-period-rollup-sync-live-closeout-verification-20260519.md`.
- No production write was performed in this verification.
