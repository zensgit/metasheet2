# Multitable Auto Number Hardening Verification - 2026-05-07

## Environment

- Worktree: `/private/tmp/ms2-autonumber-20260507`
- Branch: `codex/multitable-autonumber-field-20260507`
- Base: `origin/main@d921c93e7`

## Commands

```bash
pnpm install --frozen-lockfile
git diff --check

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auto-number-service.test.ts \
  tests/unit/record-service.test.ts \
  tests/unit/multitable-records.test.ts \
  --reporter=dot

pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-system-fields.spec.ts \
  --watch=false \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm verify:multitable-openapi:parity
```

## Results

- `pnpm install --frozen-lockfile`: passed.
- `git diff --check`: passed.
- Backend focused tests: `3 passed`, `35/35` tests passed.
- Frontend focused tests: `1 passed`, `7/7` tests passed.
- Backend type-check: passed.
- Frontend type-check: passed.
- Multitable OpenAPI parity: passed.

## Coverage Added

Backend:

- `allocateAutoNumberRange()` returns contiguous ranges from the sequence row.
- `backfillAutoNumberField()` assigns existing records in deterministic order and initializes `next_value`.
- `RecordService.createRecord()` still allocates readonly `autoNumber` values after the new lock/refactor.
- `multitable.records.createRecord()` now allocates `autoNumber` values.
- `multitable.records.createRecord()` rejects client-supplied `autoNumber` values.

Frontend:

- `formatFieldDisplay()` renders `autoNumber` prefix and zero-padding.
- Field Manager creates `autoNumber` with `prefix`, `digits`, `start`, and `startAt` property.

## Notes

- Frontend Vitest printed `WebSocket server error: Port is already in use`; the suite exited `0` and all assertions passed.
- `pnpm install` produced plugin/tool `node_modules` symlink noise in the isolated worktree. These paths were restored with `git checkout -- plugins/ tools/` before final status review.
- `pnpm verify:multitable-openapi:parity` regenerated OpenAPI dist in place and reported no tracked diff.
