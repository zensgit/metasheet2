# 考勤 Period Summaries live acceptance 脚本开发记录

Date: 2026-05-19

## Summary

本 slice 把 `attendance_report_period_summaries` 的手工 staging live closeout 固化成可重复执行的 ops harness：

- `scripts/ops/attendance-report-period-summaries-live-acceptance.mjs`
- `scripts/ops/attendance-report-period-summaries-live-acceptance.test.mjs`
- root `package.json` 新增 `verify:attendance-report-period-summaries:{live,preflight,live:test}`

不改 period rollup writer、路由、前端或多维表 schema；只新增验收脚本和文档。

## Design

脚本只通过公开 HTTP API 操作：

1. `GET /api/health`
2. `GET /api/auth/me`
3. `POST /api/attendance/report-period-summaries/sync?orgId=<org>`

验收语义：

- date range sync 必跑，并立即 rerun 一次验证 fingerprint idempotency。
- `CYCLE_ID` 存在时，payroll cycle sync 也跑两次。
- `USER_ID`、`USER_IDS`、`ALL_USERS=1` 三种用户选择都支持；`ALL_USERS` 带 `PAGE/PAGE_SIZE`。
- 每次 sync 检查 `failed=0`、`duplicateRowKeys=0`、`fieldFingerprint` 存在、`multitable.objectId=attendance_report_period_summaries`。
- rerun 检查 `skipped>=1`，如果 allUsers 当前页没有用户则接受 `usersScanned=0` 的空页。

## Auth

沿用既有 attendance report fields live harness 的安全策略：

- live mode 必须提供 `AUTH_TOKEN`、`AUTH_TOKEN_FILE` 或 `ALLOW_DEV_TOKEN=1`。
- live 写入必须显式 `CONFIRM_SYNC=1`。
- token file 必须是非空文件，并且权限为 `0600` 或更严格。
- 报告不打印 token 值。

## Package Scripts

```bash
pnpm run verify:attendance-report-period-summaries:live
pnpm run verify:attendance-report-period-summaries:preflight
pnpm run verify:attendance-report-period-summaries:live:test
```

常用 live 参数：

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_ID=<user-id> \
FROM_DATE=2026-05-15 \
TO_DATE=2026-05-17 \
CYCLE_ID=<optional-cycle-id> \
EXPECT_USERS_SCANNED=1 \
CONFIRM_SYNC=1 \
pnpm run verify:attendance-report-period-summaries:live
```

## Test Surface

`attendance-report-period-summaries-live-acceptance.test.mjs` 覆盖：

- 缺 auth / 缺 confirm / 缺 user selection 的配置校验。
- token file + explicit user 的合法配置。
- date range + payroll cycle 各自 first sync + rerun skip。
- allUsers pagination body。
- preflight 只跑 health，不需要 auth。
- help / markdown render 文案。

## Boundaries

- 不新增 `attendance_*` migration。
- 不改 `plugins/plugin-attendance/index.cjs`。
- 不直接写 `meta_*`。
- 不把 staging output 纳入 git。
- staging live 写入只通过已有 period summaries sync API。
