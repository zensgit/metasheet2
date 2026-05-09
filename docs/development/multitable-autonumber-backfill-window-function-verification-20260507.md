# Multitable autoNumber Backfill — Window Function Refactor · Verification

> Date: 2026-05-07
> Companion to: `multitable-autonumber-backfill-window-function-development-20260507.md`

## Targeted unit tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auto-number-service.test.ts --reporter=dot
```

Result:

```
 ✓ tests/unit/auto-number-service.test.ts  (4 tests) 2ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Cases:
1. `allocates a contiguous range from a field sequence` (existing — no behavior change)
2. `backfills existing records via a single window-function UPDATE and initializes next_value` (replaces the previous loop-asserting test)
3. `forwards overwrite=true to the UPDATE so existing field values are reassigned` (new)
4. `returns assigned=0 and nextValue=start when there are no eligible records` (new)

## Caller regression tests (no behavior change)

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/multitable-records.test.ts --reporter=dot
```

Result:

```
 ✓ tests/unit/multitable-records.test.ts  (15 tests)
 ✓ tests/unit/record-service.test.ts  (18 tests)
 Test Files  2 passed (2)
      Tests  33 passed (33)
```

The autoNumber-specific cases in `record-service.test.ts` (allocation during create, raw-write rejection, allocation against existing sequence) and the legacy `records.ts` helper coverage (`multitable-records.test.ts`) all pass without modification — confirms `backfillAutoNumberField`'s public contract is preserved.

## TypeScript check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed (no output / exit 0).

## Diff hygiene

```bash
git diff --check
```

Result: passed.

## Scoped diff

- `packages/core-backend/src/multitable/auto-number-service.ts` — refactor body of `backfillAutoNumberField`
- `packages/core-backend/tests/unit/auto-number-service.test.ts` — rewrite test fixture (now driven by `backfillRowCount` option) + 2 new cases
- `docs/development/multitable-autonumber-backfill-window-function-development-20260507.md` — new
- `docs/development/multitable-autonumber-backfill-window-function-verification-20260507.md` — new

`pnpm install --frozen-lockfile` in the fresh worktree caused incidental symlink rewrites under `plugins/*/node_modules/*` and `tools/cli/node_modules/*`; these are install artifacts and are NOT staged.

## What is and is not validated by these tests

**Validated**:
- The new UPDATE statement is invoked with the correct parameter shape `[fieldId, config.start, sheetId, overwrite]`
- `assigned` derives from the response's `rowCount` / `rows.length`
- The sequence-init upsert at the end uses the correct `nextValue = config.start + assigned`
- The advisory locks fire in the same order with the same keys as before
- `overwrite=true` propagates through to the SQL parameter

**NOT validated by unit tests**:
- That a real Postgres run actually mutates N rows in one round-trip (requires a live DB harness)
- The window-function ORDER BY produces the same per-row mapping as the previous loop on a real sheet (visual inspection of the SQL string + matching ORDER BY guarantees this; the test asserts the SQL string contains the exact ORDER BY)
- Performance characteristics under load (no benchmark in CI)

## Pre-deployment checks

- [x] No DingTalk / public-form runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No migration / OpenAPI / route additions.
- [x] Public function signature (`backfillAutoNumberField` arguments + return type) unchanged.
- [x] Advisory lock acquisition order and keys unchanged.
- [x] All 33 caller tests still pass without modification, confirming behavioral contract preserved.

## Result

Spec parses, types clean, diff hygiene clean, all caller tests pass without changes. The refactor is a pure performance improvement that converts an N+1 query pattern into a single UPDATE with `ROW_NUMBER()` ordering, while keeping the advisory-lock concurrency contract intact.
