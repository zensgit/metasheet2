# 考勤报表同步任务化 TODO

Date: 2026-05-19

## Summary

在 daily `attendance_report_records` 与 period `attendance_report_period_summaries` 都已具备分页同步、UI 入口、staging live evidence、live acceptance harness 后，下一步做统一的「报表同步任务层」。

目标不是改写统计逻辑，而是把现有显式分页动作编排成可恢复的 job/cursor：

- 管理员创建一个 daily 或 period sync job。
- job 保存同步参数、当前页 cursor、累计统计和最近错误。
- runner 每次只执行一个 page，复用现有 daily / period sync writer。
- 支持查询状态、继续下一页、取消、失败后重试。
- 前端展示任务进度，并保留现有手动同步入口作为低风险 fallback。

## Governance

- 默认由 Codex 驱动实现。
- Claude 只做 independent review 或 docs-only closeout，不主导 report sync 主题开发。
- 继续遵守 attendance 与 multitable report boundary：`attendance_*` 是事实源，多维表对象是可重建报表层，任务表只存运营状态。

## Public Interfaces

### New Operational Table

新增运营状态表，建议命名：

```text
plugin_attendance_report_sync_jobs
```

它不是考勤事实表，不被考勤查询 / 导出读取，只用于管理员同步任务状态。

最小字段：

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | job id |
| `org_id` | text | tenant |
| `kind` | text | `daily_records` / `period_summaries` |
| `status` | text | `queued` / `running` / `paused` / `completed` / `failed` / `canceled` |
| `mode` | text | `manual_step` / `enqueue` |
| `created_by` | text | requester |
| `period_source` | jsonb | `{from,to}` or `{cycleId}` |
| `user_selection` | jsonb | `{userId}` / `{userIds}` / `{allUsers:true}` |
| `cursor` | jsonb | `nextPage`, `pageSize`, `hasNextPage`, optional checkpoint |
| `totals` | jsonb | accumulated users / rows / created / patched / skipped / failed / duplicates |
| `last_result` | jsonb | last page response, bounded |
| `error` | text | latest terminal or page error |
| `locked_at` | timestamptz | in-process / queue lock |
| `started_at` | timestamptz | first runner start |
| `finished_at` | timestamptz | terminal time |
| `created_at` | timestamptz | insert time |
| `updated_at` | timestamptz | update time |

Indexes:

- `(org_id, status, updated_at desc)`
- `(org_id, created_at desc)`
- unique `(org_id, idempotency_key)` where `idempotency_key IS NOT NULL`.

### New APIs

All routes require `attendance:admin`.

```text
POST /api/attendance/report-sync-jobs
GET  /api/attendance/report-sync-jobs
GET  /api/attendance/report-sync-jobs/:id
POST /api/attendance/report-sync-jobs/:id/run-next-page
POST /api/attendance/report-sync-jobs/:id/cancel
```

Create body:

```json
{
  "kind": "daily_records",
  "periodSource": { "from": "2026-05-01", "to": "2026-05-31" },
  "userSelection": { "allUsers": true },
  "pageSize": 50,
  "mode": "manual_step"
}
```

For period summaries:

```json
{
  "kind": "period_summaries",
  "periodSource": { "cycleId": "..." },
  "userSelection": { "allUsers": true },
  "pageSize": 50,
  "mode": "manual_step"
}
```

v1 `mode`:

- `manual_step`: create job, administrator or frontend calls `run-next-page` until completed.
- `enqueue`: optional PR2/PR3 extension; use `context.services.queue` when available, fallback to in-process `setImmediate`.

## Execution Contract

### Daily Job

One page execution calls the existing daily bulk writer path with:

```json
{
  "from": "...",
  "to": "...",
  "allUsers": true,
  "page": cursor.nextPage,
  "pageSize": cursor.pageSize
}
```

or explicit user selection if the job was created with `userId` / `userIds`.

Do not duplicate row-level logic. The existing writer remains responsible for:

- value column resolution
- row key
- source / field fingerprint
- stale-null patch behavior
- duplicate row_key fuse
- degraded handling

### Period Job

One page execution calls the existing period bulk writer path with:

```json
{
  "from": "...",
  "to": "...",
  "allUsers": true,
  "page": cursor.nextPage,
  "pageSize": cursor.pageSize
}
```

or:

```json
{
  "cycleId": "...",
  "allUsers": true,
  "page": cursor.nextPage,
  "pageSize": cursor.pageSize
}
```

Again, do not reimplement summary formulas, subtype rollup, fingerprinting, or upsert.

## Status Machine

```text
queued -> running -> completed
queued -> running -> paused -> running -> completed
queued -> running -> failed -> running
queued -> canceled
running -> canceled
```

Rules:

- `run-next-page` may start `queued`, `paused`, or `failed` jobs.
- `running` jobs require a lock check. If `locked_at` is fresh, return 409.
- terminal `completed` / `canceled` jobs cannot run again; create a new job.
- a page-level writer `degraded:true` marks the job `failed` with `error=reason`, because task progress cannot be trusted.
- row-level failures from existing writer are accumulated in `totals.failed`; job can still continue unless all rows in a page fail.

## PR Plan

### PR1: Schema + Service Helpers

- [x] Add migration for `plugin_attendance_report_sync_jobs`.
- [x] Add helper functions inside attendance plugin:
  - normalize job body
  - map job row
  - create job
  - load job
  - initial cursor / totals skeleton
- [x] Add tests for schema-independent helpers and migration source checks.
- [x] No runner loop, no route, no UI.

**PR1 implementation pointer:** `docs/development/attendance-report-sync-jobs-pr1-development-20260519.md`; verification: `docs/development/attendance-report-sync-jobs-pr1-verification-20260519.md`.

**Deferred from PR1 to PR2:** update job progress, lock/transition validation, route validation and one-page runner. PR1 intentionally ships only storage + normalization + create/load helper skeleton so the runner PR can stay focused.

### PR2: Runner + Routes

- [x] Implement create / list / get / run-next-page / cancel routes.
- [x] Implement one-page runner that delegates to existing daily or period sync helpers.
- [x] Implement cursor update:
  - `nextPage += 1` when `hasNextPage=true`
  - terminal `completed` when explicit users done or `hasNextPage=false`
- [x] Accumulate totals deterministically.
- [ ] Use `context.services.queue` only as an optional launcher. Durable truth remains SQL job row.
- [x] Tests:
  - daily allUsers page 1 -> page 2 -> completed
  - period cycle allUsers
  - explicit userIds complete in one page
  - degraded writer marks failed
  - fresh lock returns 409
  - canceled job cannot run

**PR2 implementation pointer:** `docs/development/attendance-report-sync-jobs-pr2-development-20260519.md`; verification: `docs/development/attendance-report-sync-jobs-pr2-verification-20260519.md`.

**Deferred from PR2 to PR3/PR4:** optional queue launcher for `mode=enqueue`, frontend job UI, and live `JOB_MODE=1` acceptance. PR2 intentionally keeps execution manual-step and SQL-row durable so route/writer semantics can settle before scheduler work.

### PR3: Frontend Job UI

- Add “创建同步任务” mode beside existing immediate sync panels.
- Job list with status, progress, totals, latest error, `updatedAt`.
- Actions:
  - create daily job
  - create period job
  - run next page
  - cancel
  - open report multitable object from latest result when present
- Keep existing immediate daily / period sync controls as fallback.

### PR4: Live Acceptance Harness

- Extend existing report records and period summaries live acceptance with optional `JOB_MODE=1`.
- Verify create job -> run pages -> completed.
- Verify rerun completed job is rejected and new job can be created.
- Staging live only after explicit authorization and file-based JWT.

## Hard Boundaries

- Do not make `attendance_report_records` or `attendance_report_period_summaries` a query/export fact source.
- Do not let multitable formulas read `attendance_*`.
- Do not directly write `meta_*`.
- Do not implement automatic row dedup deletion in this slice.
- Do not implement orphan column cleanup in this slice.
- Do not remove existing immediate sync endpoints or UI.
- Do not put token values or staging output into git.

## Open Follow-ups

- Scheduled recurring sync jobs.
- Automatic cross-page worker that runs until completion without manual stepping.
- Dedup cleanup for duplicate row_key records.
- Orphan / stale column cleanup for removed fields.
- Alerting when jobs fail or duplicateRowKeys increases.
