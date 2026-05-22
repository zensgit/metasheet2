# Attendance Advanced Scheduling Workbench Aggregate Accuracy Verification

Date: 2026-05-22
Branch: `codex/attendance-advanced-scheduling-aggregate-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Runtime domain | Attendance only |
| Data Factory / Bridge Agent | Not touched |
| New migration | None |
| Schedule write path | None added |
| Direct `meta_*` writes | None |
| Multitable writes | None |
| Secrets / tokens | None |

## Acceptance Criteria

| Criterion | Evidence |
| --- | --- |
| Top workbench metrics use full aggregate counts | Backend helper accepts aggregate counts and tests assert aggregate totals override capped detail samples. |
| Detail rows remain capped samples | `metadata.sampling` reports visible vs total counts and keeps the existing sample limit. |
| Per-group coverage uses aggregate counts | Backend helper accepts schedule-group aggregate coverage rows and tests assert group table values no longer depend on sample rows. |
| UI warning is not misleading | Frontend copy says detail rows are capped while top metrics use full aggregate counts. |
| Existing read-only boundary remains intact | No write route, migration, grid edit, import, copy-paste, or multitable behavior added. |

## Verification Commands

```bash
node --check plugins/plugin-attendance/index.cjs

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-workbench.test.ts \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  --reporter=dot

NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false

pnpm --filter @metasheet/web type-check

pnpm --filter @metasheet/core-backend build

git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Backend advanced scheduling tests | PASS, 15 tests |
| Frontend admin nav + regression tests | PASS, 34 tests |
| Web type-check | PASS |
| Core backend build | PASS |
| `git diff --check` | PASS |

## Notes

- No live staging/prod operation is required for this slice. It is a local,
  read-only response-shape and aggregate-query hardening.
- If frontend Vitest emits `WebSocket server error: Port is already in use` but
  the targeted specs pass, record it as an environment warning rather than a
  product regression.
