# 考勤报表同步任务化 PR4 验证记录

Date: 2026-05-19

## Scope

验证 PR4 的 live acceptance job mode。

本轮只验证脚本、mock live harness 与文档，不运行真实 staging 写入。当前会话里上一份 staging JWT 已于 `2026-05-19T07:44:10Z` 过期；真实 staging `JOB_MODE=1` 需要 operator 重新提供文件型短期 admin JWT，并显式确认写入。

## Local Checks

| Check | Result |
| --- | --- |
| `node --check scripts/ops/attendance-report-fields-live-acceptance.mjs` | PASS |
| `node --check scripts/ops/attendance-report-fields-live-acceptance.test.mjs` | PASS |
| `node --check scripts/ops/attendance-report-period-summaries-live-acceptance.mjs` | PASS |
| `node --check scripts/ops/attendance-report-period-summaries-live-acceptance.test.mjs` | PASS |
| `node --test scripts/ops/attendance-report-fields-live-acceptance.test.mjs` | PASS, 19 tests |
| `node --test scripts/ops/attendance-report-period-summaries-live-acceptance.test.mjs` | PASS, 7 tests |
| `pnpm run verify:attendance-report-fields:live:test` | PASS, 19 tests |
| `pnpm run verify:attendance-report-period-summaries:live:test` | PASS, 7 tests |
| `git diff --check` | PASS |

## Unit Coverage Added

### Daily report-records job mode

- `JOB_MODE=1` requires explicit user selection.
- Harness creates `daily_records` job with:
  - `mode=manual_step`
  - `periodSource={from,to}`
  - `userSelection={userId}`
  - configured `JOB_PAGE_SIZE`
- Harness calls `run-next-page` until `completed`.
- Harness verifies totals exist on the final job.
- Harness verifies completed job rerun is rejected with `409 JOB_TERMINAL`.
- Harness verifies a replacement job can be created after terminal rejection, then cancels it so no queued job is left behind.
- Markdown output includes job status but does not include token material.

### Period summaries job mode

- Harness creates period `date_range` job when `JOB_MODE=1`.
- Harness creates optional `payroll_cycle` job when `CYCLE_ID` is present.
- Harness maps `USER_IDS` into `userSelection={userIds:[...]}`.
- Harness verifies each job reaches `completed`.
- Harness verifies terminal rerun is rejected with `409 JOB_TERMINAL`.
- Harness verifies replacement date-range / cycle jobs can be created and canceled.

## Staging Command Template

Use only after a fresh file-based admin JWT is available and staging writes are explicitly authorized:

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_ID=<sample-user-id> \
FROM_DATE=2026-05-01 \
TO_DATE=2026-05-13 \
JOB_MODE=1 \
JOB_PAGE_SIZE=2 \
CONFIRM_SYNC=1 \
OUTPUT_DIR=output/attendance-report-fields-live-acceptance/<run> \
pnpm run verify:attendance-report-fields:live
```

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_IDS=<sample-user-id> \
FROM_DATE=2026-05-01 \
TO_DATE=2026-05-13 \
CYCLE_ID=<optional-cycle-id> \
JOB_MODE=1 \
PAGE_SIZE=2 \
CONFIRM_SYNC=1 \
OUTPUT_DIR=output/attendance-report-period-summaries-live-acceptance/<run> \
pnpm run verify:attendance-report-period-summaries:live
```

## Boundary Verification

- Job mode calls only existing PR2 routes:
  - `POST /api/attendance/report-sync-jobs`
  - `POST /api/attendance/report-sync-jobs/:id/run-next-page`
- Existing immediate sync and report-field checks remain intact.
- No plugin writer or route logic changed.
- No frontend code changed.
- No migration changed.
- No secret, JWT, or generated staging output is committed.

## Deferred Live Evidence

Real staging `JOB_MODE=1` evidence remains pending fresh credentials. The expected live evidence should include:

- daily job create -> run pages -> completed
- period date-range job create -> run pages -> completed
- optional period cycle job create -> run pages -> completed
- completed job rerun rejected with `409 JOB_TERMINAL`
- replacement job create + cancel
