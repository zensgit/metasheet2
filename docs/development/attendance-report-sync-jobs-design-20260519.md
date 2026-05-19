# 考勤报表同步任务化设计记录

Date: 2026-05-19

## Context

已有能力：

- daily `attendance_report_records`
  - single user sync
  - `userIds` batch sync
  - `allUsers` explicit page sync
  - staging live evidence
- period `attendance_report_period_summaries`
  - date range sync
  - payroll cycle sync
  - `userIds` / `allUsers` explicit page sync
  - frontend入口
  - staging live evidence
  - live acceptance harness

缺口：管理员仍要手动决定 page 并重复点击。大租户需要一个可恢复、可查询、可继续执行的 job/cursor 层。

## Chosen Direction

采用「SQL job state + existing writer delegation」。

理由：

- job 状态需要持久、可恢复、可分页查询，多维表 report object 不适合承载控制面状态。
- `context.services.queue` 当前可以作为执行器，但 durable truth 仍需要 SQL job row。
- daily / period 两条 writer 已经锁定 upsert、fingerprint、stale-null、duplicate row_key 语义；任务层重复实现会增加漂移。

## Why Not

### Not Direct Multitable Job State

不把 job 状态写到 `attendance_report_records` 或 `attendance_report_period_summaries`：

- report object 是报表快照，不是控制面。
- report object 可重建；job 状态不可简单重建。
- report object 的权限/视图/公式面向协作，不适合保存 runner lock。

### Not A Single “Sync Everything” Endpoint

不新增一次性全量同步端点直接跑到底：

- HTTP 超时风险高。
- 失败无法恢复到具体 page。
- 无法给 UI 稳定进度和取消能力。

### Not Cleanup/Dedup First

重复 row_key dedup 和 orphan column cleanup 都是破坏性清理能力。任务化先提供观察、计数、失败恢复；清理由后续单独 slice 做。

## Data Model

`plugin_attendance_report_sync_jobs` 是运营状态表。

它不属于考勤事实源，不被报表查询/导出读取。它只回答：

- 要同步什么？
- 现在同步到哪一页？
- 已经同步了多少？
- 是否失败，失败在哪里？

建议 status:

```text
queued
running
paused
completed
failed
canceled
```

建议 kind:

```text
daily_records
period_summaries
```

`period_source` 与 `user_selection` 保持 JSONB，避免把 daily 与 period 的参数硬拆成多列；但 `org_id/status/created_at` 必须可索引。

## Cursor Semantics

`cursor` 最小 shape：

```json
{
  "nextPage": 1,
  "pageSize": 50,
  "hasNextPage": true
}
```

规则：

- explicit `userId` / `userIds` job 一页完成。
- `allUsers` job 根据 writer 返回的 `hasNextPage` 更新。
- job runner 不自己查 users 表；它把 page/pageSize 交给现有 writer。
- 如果 writer 返回 `usersScanned=0` 且 `hasNextPage=false`，job completed，totals 保持 0。

## Totals

`totals` 累加现有 writer 返回值：

```json
{
  "usersScanned": 0,
  "usersSynced": 0,
  "usersFailed": 0,
  "synced": 0,
  "rowsSynced": 0,
  "created": 0,
  "patched": 0,
  "skipped": 0,
  "failed": 0,
  "duplicateRowKeys": 0
}
```

`fieldFingerprint`、`syncedAt`、`multitable` 保存在 `last_result`，不做累加。

## Locking

最小实现：

- `run-next-page` 在 transaction 中把非 terminal job 从 `queued|paused|failed` 置为 `running` 并写 `locked_at=now()`。
- 如果 job 已是 `running` 且 `locked_at` 未过期，返回 409。
- page 执行结束后根据结果写回 `queued` / `completed` / `failed`。
- lock TTL 建议 10 分钟，后续可配置。

## API Response Shape

Job projection:

```json
{
  "id": "...",
  "orgId": "default",
  "kind": "daily_records",
  "status": "running",
  "periodSource": { "from": "2026-05-01", "to": "2026-05-31" },
  "userSelection": { "allUsers": true },
  "cursor": { "nextPage": 2, "pageSize": 50, "hasNextPage": true },
  "totals": {},
  "lastResult": {},
  "error": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`run-next-page` returns:

```json
{
  "ok": true,
  "data": {
    "job": {},
    "pageResult": {}
  }
}
```

## Frontend

PR3 UI should be quiet and operational:

- no marketing copy
- compact task table
- status badge
- progress text `page n / done`
- totals columns
- last error inline
- actions: run next page, cancel, refresh, open multitable

Keep existing immediate sync buttons as the “small tenant / emergency fallback”.

## Review Contract

每个 implementation PR 必须回答：

- 是否只调用 existing daily / period sync writer？
- 是否没有直接写 `meta_*`？
- 是否没有把 job table 当事实源？
- 是否保留 immediate sync endpoints？
- 是否 token / staging output 不入库？
- 是否失败可恢复到 page 级别？
