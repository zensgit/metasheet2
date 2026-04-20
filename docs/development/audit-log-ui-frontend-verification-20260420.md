# Audit Log UI · Frontend Rewire — Verification (20260420)

Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/audit-ui`
Branch: `codex/audit-log-ui-frontend-202605` (based on `origin/main` `0756ff61d`)

## Commands executed

```bash
cd /Users/chouhua/Downloads/Github/metasheet2/.worktrees/audit-ui

# 1. Install dependencies
pnpm install
# -> Done in 2.9s (pnpm v10.33.0, ignored build scripts as usual)

# 2. Frontend typecheck (strict Vue SFC check)
pnpm --filter @metasheet/web exec vue-tsc --noEmit
# -> clean (no output / exit 0)

# 3. New spec
pnpm --filter @metasheet/web exec vitest run tests/adminAuditView.spec.ts --reporter=dot
# -> Test Files  1 passed (1)
# -> Tests       5 passed (5)

# 4. Neighbour admin view regression
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --reporter=dot
# -> Test Files  1 passed (1)
# -> Tests       33 passed (33)
```

## Test inventory (`tests/adminAuditView.spec.ts`)

| # | Scenario                                         | Coverage                                                                                                      |
|---|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| 1 | Loads audit logs on mount                         | URL starts with `/api/audit-logs?`, includes `page=1&pageSize=20`; table renders actor/action/resource cells. |
| 2 | Empty state                                       | `items: []` payload renders "暂无审计日志".                                                                   |
| 3 | Filter propagation + ISO date bounding            | `resourceType`, `action`, `actorId`, `from=…T00:00:00.000Z`, `to=…T23:59:59.999Z`, `page=1` on 刷新 click.    |
| 4 | Pagination                                        | 下一页 click issues `page=2` fetch and pager text updates to "第 2 / 3 页".                                 |
| 5 | CSV export                                        | Button triggers `GET /api/audit-logs?…&format=csv&limit=100000` with filters; success status visible.         |

## Manual smoke notes

No manual browser smoke performed (pure-frontend slice, unit tests cover the
surface). The rewire is strictly additive from the backend's POV — the old
routes never existed, so the "before" state was 404 across the board.

### Observed stderr

Vitest reports `Not implemented: navigation to another Document` once during
the spec run. This comes from the JSDOM environment's reaction to the
synthetic `<a>.click()` inside `downloadBlob()`. It does not fail the test
because we mock `URL.createObjectURL`, and it's the same diagnostic already
printed by the neighbouring `directoryManagementView` spec suite.

## Screenshots

Skipped — out of scope for a frontend rewire that leaves the visual skeleton
substantially unchanged (header, summary cards, single table, placeholder
panel).

## Non-test checks performed

- Confirmed `operation_audit_logs.id` is a `uuid` (see
  `packages/core-backend/src/db/migrations/20250926_create_operation_audit_logs.ts`)
  and updated `AdminAuditLogItem.id` to `string`.
- Confirmed auth handling: `apiFetch` injects `Authorization: Bearer ...` from
  `localStorage`. A raw `<a href>` or `window.open` would drop it. Kept the
  existing `apiFetch → blob → object URL` download path.
- Confirmed `z.string().datetime()` on the backend rejects `YYYY-MM-DD` — the
  new view converts `<input type="date">` values to strict ISO-8601 datetimes
  before appending them to the query string.

## Outstanding

- Session revocations panel is a placeholder until a backend endpoint ships.
- No broader `pnpm test` run was done (per task scope: new spec + one
  neighbour regression).
