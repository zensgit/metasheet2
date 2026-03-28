# Multitable Import Abort / Cancel

## Goal

Finish the import hardening slice by making cancel propagate through the full stack:

- modal UX can cancel while importing
- workbench aborts the active import request set
- bulk import stops before later chunks start
- aborted imports do not degrade into ordinary failed-row results

## Design

### 1. Propagate `AbortSignal` into record creation

- `MultitableApiClient.createRecord(...)` now accepts `opts?: { signal?: AbortSignal }`
- the signal is forwarded to `fetch(...)`

This gives the import pipeline a real cancellation primitive instead of only a UI-level flag.

### 2. Make `bulkImportRecords(...)` abort-aware

- add `signal?: AbortSignal`
- add `ensureNotAborted(...)` checks before chunk execution and retry boundaries
- make the default sleep helper abort-aware
- pass the same signal into each `createRecord(...)` call
- detect `AbortError` after `Promise.allSettled(...)` and rethrow it

That last step is critical: without it, cancellation gets flattened into ordinary failed rows and the modal never exits the “importing” state cleanly.

### 3. Keep modal close behavior intuitive during import

- `MetaImportModal` now emits `cancel-import` instead of `close` while importing
- the header close button remains available
- the importing state also shows an explicit `Cancel import` action

### 4. Workbench owns the active import controller

- `MultitableWorkbench` now creates an `AbortController` for each bulk import
- `cancelImport()` aborts the controller
- aborted imports:
  - close the modal
  - reload view data
  - show `Import cancelled`

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run tests/multitable-import.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-workbench-import-flow.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-import.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-people-import.spec.ts tests/multitable-link-picker.spec.ts tests/multitable-workbench-import-flow.spec.ts tests/multitable-workbench-view.spec.ts tests/multitable-field-manager.spec.ts tests/multitable-form-view.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- focused abort/cancel regressions: `3 files / 28 tests passed`
- expanded import/workbench regressions: passed
- `@metasheet/web build`: passed

## Notes

- existing retry tests had to be widened from fixed `600ms` timer advancement because import retry backoff now includes jitter
- cancellation now preserves the intended UX boundary:
  aborted work is treated as cancellation, not as an import failure report
