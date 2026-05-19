# 考勤报表同步任务化验证记录

Date: 2026-05-19

## Scope

本轮是 docs-only 设计切片，不实现 migration、route、runner 或 UI。

验证目标：

- 从现有代码和文档确认 daily / period sync 都已具备分页 writer。
- 明确任务化层复用 existing writer，不重写报表统计。
- 给后续 PR1/PR2/PR3/PR4 固定验证矩阵。

## Orientation Evidence

| Evidence | Result |
| --- | --- |
| daily bulk sync | `POST /api/attendance/report-records/sync` 已支持 `userIds` 与 `allUsers/page/pageSize` |
| period bulk sync | `POST /api/attendance/report-period-summaries/sync` 已支持 date range / cycle + `userIds` / `allUsers/page/pageSize` |
| live harness | period summaries live acceptance 已存在并在 staging smoke 中 34 checks PASS |
| async import precedent | attendance import 已有 SQL job row + queue fallback 模式，可作为 shape 参考 |
| queue service | `context.services.queue` 可作为执行器，但 durable truth 应在 SQL job row |

## Commands

```bash
git fetch origin main --quiet
rg -n "batch cursor|后台任务|allUsers|period|report-records|period-summaries|sync job|cursor|duplicateRowKeys|stale" docs/development
rg -n "attendance_import_jobs|context.services.queue|processAsyncImportCommitJob" plugins/plugin-attendance/index.cjs packages/core-backend/src/services/QueueService.ts
git diff --check
```

## Planned PR Validation Matrix

### PR1: Schema + Helpers

- migration applies and rolls back cleanly.
- table is named `plugin_attendance_report_sync_jobs`, not a report object.
- helper maps row JSON safely with bounded `last_result`.
- invalid `kind`, invalid period source, mixed user selection all rejected.
- no `meta_*` writes.

### PR2: Runner + Routes

- create daily allUsers job.
- run next page delegates to daily writer and advances cursor.
- create period cycle job.
- run next page delegates to period writer and advances cursor.
- explicit userIds job completes in one page.
- fresh running lock returns 409.
- stale lock can resume.
- degraded writer marks job failed.
- canceled job cannot run.
- completed job cannot run again.

### PR3: Frontend

- create job form builds daily body.
- create job form builds period cycle body.
- job table renders status, cursor, totals, last error.
- run next page calls route and refreshes job.
- cancel disables further run.
- immediate sync UI still exists.

### PR4: Live Acceptance

- create job on staging.
- run pages until completed.
- verify final totals are non-negative and page cursor terminal.
- verify report object fingerprints still present through existing live harness.
- token read from file only; no token literal in output.

## Current Docs-only Validation

Expected before PR:

- `git diff --check` PASS.
- sensitive literal scan over staged docs finds no JWT / private key / bearer token.
- no code or migration file staged.
