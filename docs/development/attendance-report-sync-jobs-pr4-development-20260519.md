# 考勤报表同步任务化 PR4 开发记录

Date: 2026-05-19

## Summary

本轮落地 PR4：给现有 live acceptance harness 增加可选 `JOB_MODE=1`，用于验证 PR2/PR3 的 report sync job 控制面。

范围保持为 ops harness：

- daily `attendance_report_records`：在 `attendance-report-fields-live-acceptance` 中增加 job mode。
- period `attendance_report_period_summaries`：在 `attendance-report-period-summaries-live-acceptance` 中增加 job mode。
- job mode 创建 `manual_step` 任务，循环调用 `run-next-page` 直到 `completed` 或超过 `JOB_MAX_PAGES`。
- job 完成后再调用一次 `run-next-page`，断言后端返回 `409 JOB_TERMINAL`。
- terminal rerun 被拒后再创建一个新 job 并立即 cancel，验证完成任务不阻塞后续新任务，同时不留下 queued job。
- 默认不启用 job mode；没有 `JOB_MODE=1` 时只记录 skipped check。

本轮不改 attendance 业务逻辑、不改 writer、不改 route、不改前端、不新增 migration。

## Files

| File | Change |
| --- | --- |
| `scripts/ops/attendance-report-fields-live-acceptance.mjs` | 增加 daily job-mode 配置、创建/逐页执行/terminal rerun 验证 |
| `scripts/ops/attendance-report-fields-live-acceptance.test.mjs` | mock `report-sync-jobs` API，覆盖 daily job mode |
| `scripts/ops/attendance-report-period-summaries-live-acceptance.mjs` | 增加 period date-range / optional payroll-cycle job-mode 验证 |
| `scripts/ops/attendance-report-period-summaries-live-acceptance.test.mjs` | mock period job create/run/rerun，覆盖 date range 与 cycle |
| `docs/development/attendance-report-sync-jobs-todo-20260519.md` | PR4 勾选并指向本轮开发 / 验证 MD |
| `docs/development/attendance-report-sync-jobs-pr4-*.md` | 本轮开发与验证记录 |

## Runtime Contract

### Daily Job Mode

`attendance-report-fields-live-acceptance` 仍先完成字段目录、records、export、CSV header 证据链。仅当 `JOB_MODE=1` 时追加 daily job 验证。

Job body:

```json
{
  "kind": "daily_records",
  "mode": "manual_step",
  "pageSize": 5,
  "periodSource": { "from": "2026-05-01", "to": "2026-05-13" },
  "userSelection": { "userId": "..." }
}
```

Daily job mode 要求显式 user selection：

- `USER_ID=<id>`；或
- `JOB_USER_IDS=<id,id>` / `USER_IDS=<id,id>`；或
- `JOB_ALL_USERS=1` / `ALL_USERS=1`。

这样避免 operator 只想跑字段目录验收时误触发全员 report-records 写入。

### Period Job Mode

`attendance-report-period-summaries-live-acceptance` 仍先跑 immediate period sync 的 date range；若 `CYCLE_ID` 存在，也继续跑 payroll-cycle immediate sync。仅当 `JOB_MODE=1` 时追加对应 job 验证：

- date range period job 永远验证；
- payroll cycle period job 仅在 `CYCLE_ID` 存在时验证。

Job body:

```json
{
  "kind": "period_summaries",
  "mode": "manual_step",
  "pageSize": 5,
  "periodSource": { "from": "2026-05-01", "to": "2026-05-13" },
  "userSelection": { "userIds": ["u-1", "u-2"] }
}
```

或：

```json
{
  "kind": "period_summaries",
  "mode": "manual_step",
  "pageSize": 5,
  "periodSource": { "cycleId": "..." },
  "userSelection": { "allUsers": true }
}
```

## Checks Added

每个 job-mode flow 记录：

- `*.job.created`
- `*.job.completed`
- `*.job.pages-within-limit`
- `*.job.totals-present`
- `*.job.terminal-rerun-rejected`
- `*.job.new-job-created`
- `*.job.new-job-canceled`

`terminal-rerun-rejected` 锁定 PR2 contract：`completed` job 不能再次运行，必须返回 `409 JOB_TERMINAL`。

## Boundaries

- 不新增或修改 `attendance_*` migration。
- 不让多维表成为考勤查询 / 导出的事实源。
- 不直接写 `meta_*`。
- 不改 `POST /api/attendance/report-sync-jobs` 或 writer 逻辑。
- 不实现 scheduler / queue auto-run。
- 不提交 staging JWT、token literal 或 live output。

## Claude

本轮由 Codex 实现。若需要二审，Claude 适合按 PR4 ops-harness contract review：确认 job mode 只调用既有 PR2 routes、没有改业务 writer、没有把 staging output 或 token 写入仓库。
