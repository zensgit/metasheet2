# Flake Lead — `attendance-plugin.test.ts` commit-async skipped-summary exact-count — 2026-05-26

**Status:** follow-up lead (docs-only). Not a fix. Captures a reproduced intermittent failure in a
gated integration test so a future test-stabilization slice can start from evidence rather than
re-discovery. **Escalate to a GitHub issue if it recurs.**

## The test

`packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `it(...)` — **`retains compact skipped summary for completed commit-async jobs and idempotent retry`** (`:5285`)
- Failing assertions (exact counts):
  - `:5378  expect(Number(completedJob?.failedRows ?? 0)).toBe(1)`  ← observed `0`
  - `:5379  expect(Number(completedJob?.skippedCount ?? 0)).toBe(1)`

This is a **gated** suite (`describeIfDatabase`, needs `DATABASE_URL`); it runs in the
`test (18.x)` / `test (20.x)` CI jobs, not in a bare `pnpm test`.

## Evidence it is flaky (not a product/PR regression)

Observed during PR #1900 (§7 payroll-cycle cap validation):
- Run `26492884741` `test (18.x)` → **1 failed** (`expected +0 to be 1`); `test (20.x)` CANCELLED (fail-fast cascade).
- `gh run rerun --failed` on the same commit → **both pass**.
- A subsequent rebase + fresh full run → **both pass**.
- The same test is **green on `origin/main`** across the prior 5 commits.
- PR #1900's diff touched only `plugins/plugin-attendance/index.cjs` (comprehensive-hours / payroll-cycle cap mapping) + its unit test + a doc — **nothing** in the bulk-import / commit-async / `failedRows` path.

Conclusion: same code passes and fails across runs ⇒ non-deterministic, not caused by the change under test.

## Suspected root cause (strong lead, unverified)

In the same file, the **neighboring** commit-async assertions are written tolerantly:
- `:5003 / :5133 / :5134 / :5153  …failedRows ?? 0)).toBeGreaterThanOrEqual(0)`

Only `:5378 / :5379` assert an **exact** `toBe(1)` on an **async commit job's** failed/skipped row
accounting. If the job's failed/skipped tally is read before the async commit has fully settled (or
an idempotent-retry path double-counts/under-counts transiently), an exact `toBe(1)` is the most
brittle shape and would intermittently observe `0`.

## Candidate stabilization (for the eventual slice — NOT done here)

- Await deterministic job settle before reading `completedJob` (poll job status to a terminal
  state, not a fixed delay), **then** assert exact counts; or
- Align `:5378/:5379` with the neighboring tolerant style **only if** an exact count isn't the
  property under test (verify intent first — this test's name implies the skipped/failed *summary*
  is the point, so prefer the settle-then-assert fix over weakening the assertion).
- Reproduction requires a real DB (`DATABASE_URL`) — the slice is a separate opt-in.

## Not in scope

No test/code change in this doc. No claim the product is wrong (it is not — see evidence). This is
a lead to avoid re-triaging the same flake next time merge cadence is interrupted.
