# Multitable M2 slice 2 — record-service verification log

Date: 2026-04-23
Branch: `codex/multitable-m2-record-service-20260423`
Initial base: `main@6d5f965e4`
Rebased base before PR update: `main@78d382aa`
Paired with: `docs/development/multitable-m2-record-service-development-20260423.md`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/multitable-attachment-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-permissions.api.test.ts \
  -t "allows create, form submit, patch, and own delete when sheet permission is write-own without global multitable permission"

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-realtime.api.test.ts \
  -t "publishes spreadsheet.cell.updated after creating a record"

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-realtime.api.test.ts \
  --reporter=dot

git diff --check
```

## Results

### New focused service tests

- `tests/unit/record-service.test.ts`: `7/7` pass

Coverage:

- create success
- create missing link target
- create field validation failure
- delete success
- delete expected-version conflict
- delete own-write policy rejection
- delete missing record

### Type-check

- `packages/core-backend`: `tsc --noEmit` passed with exit `0`

### Adjacent regression

- `tests/unit/record-service.test.ts`: `7/7` pass
- `tests/unit/record-write-service.test.ts`: `25/25` pass
- `tests/unit/multitable-attachment-service.test.ts`: `24/24` pass
- Aggregate: `56/56` pass

Known log during regression:

- `record-write-service.test.ts` intentionally logs one Yjs invalidation failure
  in the test that verifies invalidator errors are swallowed; this is expected.

### Route-level regression

- `multitable-sheet-permissions.api.test.ts`: write-own create/form/patch/delete
  focused case passed (`1/1`; 38 skipped by `-t`)
- `multitable-sheet-realtime.api.test.ts`: direct create realtime publish focused
  case passed (`1/1`; 2 skipped by `-t`)
- `multitable-sheet-realtime.api.test.ts`: full file passed (`3/3`) after
  updating the isolated route mock for `created_by` projections and shared
  sheet-permission scope queries.

Known log during the write-own route regression:

- The existing integration mock does not cover one formula dependency lookup in
  the form/patch path, so the route logs a swallowed formula recalculation
  warning. The focused test still passes and this is unrelated to the extracted
  direct create/delete service path.

### Whitespace

- `git diff --check`: passed

## Contract checks

- Direct create still returns `{ ok: true, data: { record: { id, version, data } } }`
- Direct create field-validation still returns HTTP `422` at the route layer
- Direct delete still returns `{ ok: true, data: { deleted: recordId } }`
- Direct delete `expectedVersion` mismatch still maps to HTTP `409`
- Patch write path remains on `RecordWriteService` and was regression-tested

## Rebase verification — 2026-04-23

After `fix(metrics): add scrape token guard` landed on main, the branch was
rebased from `main@6d5f965e4` to `main@78d382aa`.

Commands rerun after rebase:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/multitable-attachment-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-realtime.api.test.ts \
  --reporter=dot

git diff --check
```

Results:

- `packages/core-backend`: `tsc --noEmit` passed with exit `0`
- Unit regression: `56/56` passed
- Route-level realtime integration: `3/3` passed
- `git diff --check`: passed

Known logs remained unchanged:

- `record-write-service.test.ts` logs the intentional swallowed Yjs
  invalidation error
- `multitable-sheet-realtime.api.test.ts` logs the pre-existing formula
  dependency mock warning in the form submit case
