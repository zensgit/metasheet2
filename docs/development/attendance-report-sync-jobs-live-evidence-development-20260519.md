# 考勤报表同步任务化 Live Evidence 开发记录

Date: 2026-05-19

## Summary

本轮完成 PR4 后续真实 staging `JOB_MODE=1` 验收准备与环境修复。

范围是 staging ops/evidence，不新增产品代码：

- 将 8082 staging backend/web 更新到最新 `origin/main` 镜像 `a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1`。
- 使用文件型短期 admin JWT，通过 `AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt` 读取，不在命令输出或文档中记录 token。
- 发现 staging DB 未应用 `plugin_attendance_report_sync_jobs` operational table schema，且全量 migration list 有 77 个 pending。
- 为避免超出本轮验收边界，没有运行全量 migration；仅按已合并 migration `zzzz20260519070000_create_plugin_attendance_report_sync_jobs` 的 DDL 创建 job runner operational table 与索引。
- 重跑 daily report records 与 period summaries 的 live acceptance `JOB_MODE=1`，两条均通过。

本轮不修改 `attendance_*` 事实源，不写 `meta_*`，不提交 generated `output/` evidence。

## Staging Runtime Prep

| Step | Result |
| --- | --- |
| Health before route validation | `/api/health` returned `ok` |
| Route before schema fix | `GET /api/attendance/report-sync-jobs` returned `503 DB_NOT_READY` |
| Latest main image | `a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` |
| Staging backend/web after update | `ghcr.io/zensgit/metasheet2-backend:a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` and matching web image |
| Migration preview | `--list` reported 77 pending migrations |
| Narrow staging schema repair | Created only `plugin_attendance_report_sync_jobs` and indexes |
| Route after schema fix | `GET /api/attendance/report-sync-jobs` returned `200 {"ok":true,"data":{"items":[]}}` |

## Narrow DDL Rationale

The job runner route requires `plugin_attendance_report_sync_jobs`.
Running the full migration set on staging would have applied 77 pending migrations, which is larger than this live evidence slice.
The narrow DDL follows the merged migration contract:

- `id uuid primary key default gen_random_uuid()`
- `org_id`, `kind`, `status`, `mode`
- JSONB operational state: `period_source`, `user_selection`, `cursor`, `totals`, `last_result`
- lock/progress timestamps
- kind/status/mode check constraints
- org/status and org/created indexes
- unique idempotency index

This table is operational cursor/progress state only. It is not an attendance fact source and is not read by attendance query/export paths.

## Live Commands

Daily report records job-mode acceptance:

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_ID=<sample-admin-user-id> \
FROM_DATE=2026-05-15 \
TO_DATE=2026-05-17 \
JOB_MODE=1 \
JOB_PAGE_SIZE=2 \
JOB_MAX_PAGES=5 \
CONFIRM_SYNC=1 \
OUTPUT_DIR=output/attendance-report-fields-live-acceptance/2026-05-19-job-mode-daily-after-staging-update \
pnpm run verify:attendance-report-fields:live
```

Period summaries job-mode acceptance:

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_ID=<sample-admin-user-id> \
FROM_DATE=2026-05-15 \
TO_DATE=2026-05-17 \
CYCLE_ID=<sample-payroll-cycle-id> \
JOB_MODE=1 \
PAGE_SIZE=2 \
JOB_MAX_PAGES=5 \
CONFIRM_SYNC=1 \
OUTPUT_DIR=output/attendance-report-period-summaries-live-acceptance/2026-05-19-job-mode-period-after-staging-update \
pnpm run verify:attendance-report-period-summaries:live
```

## Boundaries

- No product code was changed in this evidence slice.
- No `attendance_*` fact-table migration was introduced or run specifically for this slice.
- No `meta_*` table was written directly.
- No token/JWT literal was printed into committed files.
- Local `output/` evidence remains untracked and is intentionally not committed.
- The staging schema repair is documented as an environment alignment step; the committed product migration remains the source of truth.
