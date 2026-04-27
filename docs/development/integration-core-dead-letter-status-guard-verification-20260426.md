# Integration-Core Dead-Letter Status Guard · Verification

> Date: 2026-04-26
> Companion: `integration-core-dead-letter-status-guard-design-20260426.md`
> PR: #1191

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
```

## Result — pipeline-runner.test.cjs

```
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
```

## Result — full suite regression (18 files)

All 18 integration-core test files pass. 0 regressions.

## New test coverage breakdown (3 added)

| # | Scenario | What it pins |
|---|---|---|
| 6a | Double-replay of `status='replayed'` letter → `PipelineRunnerError`, message contains "status is not open", details include `status:'replayed'` and `id:'dl_1'` | Main bug: second replay blocked before ERP call |
| 6b | `targetRows.size` unchanged after rejected double-replay | No ERP side effect — `runPipeline` never called |
| 6c | Replay of `status='discarded'` letter → `PipelineRunnerError` with `status:'discarded'` in details | Discarded-letter case covered |

## Manual code review checklist

- [x] Guard placed after `getDeadLetter` but before `isTruncatedReplayPayload` — both
  non-open guards fire before any payload inspection or ERP call
- [x] Error class is `PipelineRunnerError` — maps to HTTP 422 via existing `inferHttpStatus`
  (`/PipelineRunner/.test(name)`)
- [x] Error details include `id` and `status` — operator can diagnose without a DB query
- [x] Message uses "status is not open" — test verifies this exact substring
- [x] `status='open'` path unchanged — existing scenario 5 (successful replay) still passes
- [x] No new external dependency introduced
- [x] `createDeadLetterStore` status validation (`VALID_STATUSES`) enforces the
  three-state domain at write time; the guard at read time is a defense-in-depth layer
