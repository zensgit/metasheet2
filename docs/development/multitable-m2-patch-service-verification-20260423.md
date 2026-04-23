# Multitable M2 slice 3 — direct PATCH service verification log

Date: 2026-04-23
Branch: `codex/multitable-m2-patch-service-20260423`
Base: `main@61f32f318`
Paired with: `docs/development/multitable-m2-patch-service-development-20260423.md`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/multitable-attachment-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/yjs-rest-invalidation.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-record-form.api.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-permissions.api.test.ts \
  -t "allows create, form submit, patch, and own delete when sheet permission is write-own without global multitable permission" \
  --reporter=dot

git diff --check
```

## Results

### Type-check

- `packages/core-backend`: `tsc --noEmit` passed with exit `0`

### Focused service tests

- `tests/unit/record-service.test.ts`: `11/11` passed

New patch coverage:

- successful scalar + link patch
- Yjs invalidation after direct REST patch
- link delta delete/insert
- hidden field rejection with legacy forbidden classification
- expectedVersion conflict before update
- own-write policy rejection

### Adjacent unit regression

- `tests/unit/record-service.test.ts`: `11/11` passed
- `tests/unit/record-write-service.test.ts`: `25/25` passed
- `tests/unit/multitable-attachment-service.test.ts`: `24/24` passed
- Aggregate: `60/60` passed
- `tests/unit/yjs-rest-invalidation.test.ts`: `9/9` passed

Known log during regression:

- `record-write-service.test.ts` intentionally logs one swallowed Yjs
  invalidation failure in the test that verifies invalidator errors do not fail
  REST patch writes.

### Route-level integration regression

- `tests/integration/multitable-record-form.api.test.ts`: `18/18` passed
- `tests/integration/multitable-sheet-permissions.api.test.ts` focused
  write-own case: `1/1` passed (`38` skipped by `-t`)

Known log during the write-own route regression:

- The existing integration mock does not cover one formula dependency lookup in
  the form/patch path, so the route logs a swallowed formula recalculation
  warning. This log existed before this extraction and the focused assertion
  passed.

### Whitespace

- `git diff --check`: passed

## Contract checks

- Direct PATCH still returns `{ ok: true, data: { record, commentsScope } }`.
- Direct PATCH `expectedVersion` mismatch still maps to HTTP `409`.
- Hidden-only field errors still map to HTTP `403` / `FIELD_HIDDEN`.
- Readonly-only field errors still map to HTTP `403` / `FIELD_READONLY`.
- Mixed validation errors still map to HTTP `400` / `VALIDATION_ERROR`.
- `POST /patch` remains on `RecordWriteService` and was regression-tested.
