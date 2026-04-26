# Integration-Core List Endpoint Limit Cap · Verification

> Date: 2026-04-26
> Companion: `integration-core-list-limit-cap-design-20260426.md`
> PR: #1192

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
```

## Result — http-routes.test.cjs

```
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
```

## Result — full suite regression (18 files)

All 18 integration-core test files pass. 0 regressions.

## New test coverage breakdown (3 added in `testRunAndDeadLetterRoutes`)

| # | Scenario | What it pins |
|---|---|---|
| 1 | `limit=MAX_LIST_LIMIT+10000` on runs endpoint → registry receives `MAX_LIST_LIMIT` | Over-limit clamped |
| 2 | `limit=10` on runs endpoint → registry receives `10` | Under-limit unchanged |
| 3 | `limit=999999` on dead-letters endpoint → registry receives `MAX_LIST_LIMIT` | Dead-letters endpoint covered |

## Manual code review checklist

- [x] `asListLimit` uses `asPositiveInt` internally — inherits all existing edge-case handling
  (undefined/null/empty → undefined; non-integer → undefined; zero/negative → undefined)
- [x] `Math.min(n, MAX_LIST_LIMIT)` — caps but does not reject
- [x] All four list endpoints use `asListLimit`; all three non-list uses (`offset`, `sampleLimit`,
  body integer params) retain `asPositiveInt` — no unintended capping
- [x] `MAX_LIST_LIMIT` exported at module level — UI and test code can reference the constant
  rather than hardcoding 500
- [x] `asListLimit` exported under `__internals` — available for unit tests without exposing
  as a public API
- [x] Existing test assertions for `limit: 20` and `limit: 20` (dead-letters) are unchanged
  — 20 < 500, so they pass through
