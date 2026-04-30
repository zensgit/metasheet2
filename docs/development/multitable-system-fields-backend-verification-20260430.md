# Multitable System Fields Backend - Verification - 2026-04-30

## Environment

- Worktree: `/tmp/ms2-system-fields-backend-20260430`
- Branch: `codex/multitable-system-fields-backend-20260430`
- Base commit: `origin/main@9d148580`
- Node: `v24.14.1`
- pnpm: `10.33.0`

The `/tmp` worktree required `pnpm install --ignore-scripts` so package binaries were available. Plugin/tool node_modules symlink churn from that install was reverted before commit.

## Commands Run

```bash
pnpm install --ignore-scripts
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-query-service.test.ts tests/unit/record-write-service.test.ts tests/unit/record-service.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-record-patch.api.test.ts tests/integration/multitable-xlsx-routes.test.ts tests/unit/multitable-records.test.ts --reporter=dot
CI=1 pnpm --filter @metasheet/core-backend test
pnpm run verify:multitable-openapi:parity
pnpm exec tsx packages/openapi/tools/validate.ts
git diff --check
```

## Results

### Backend Build

```text
> @metasheet/core-backend@2.5.0 build /private/tmp/ms2-system-fields-backend-20260430/packages/core-backend
> tsc
```

### Focused Unit Tests

```text
✓ tests/unit/multitable-query-service.test.ts  (5 tests) 4ms
✓ tests/unit/record-write-service.test.ts  (34 tests) 14ms
✓ tests/unit/record-service.test.ts  (13 tests) 8ms

Test Files  3 passed (3)
     Tests  52 passed (52)
```

Expected stderr:

- Existing post-commit hook tests intentionally log simulated hook failures.
- `DATABASE_URL not set` warning comes from existing test bootstrap behavior.

### CI Failure Reproduction Tests

GitHub CI initially failed `test (18.x)` / `test (20.x)` on five assertions across:

- `tests/integration/multitable-record-patch.api.test.ts`
- `tests/integration/multitable-xlsx-routes.test.ts`
- `tests/unit/multitable-records.test.ts`

Cause: test doubles matched the old exact record projection and old three-argument record update. The implementation now legitimately selects record metadata and passes `modified_by`.

After tightening those tests:

```text
✓ tests/unit/multitable-records.test.ts  (13 tests) 10ms
✓ tests/integration/multitable-xlsx-routes.test.ts  (4 tests) 306ms
✓ tests/integration/multitable-record-patch.api.test.ts  (6 tests) 504ms

Test Files  3 passed (3)
     Tests  23 passed (23)
```

### Full Backend Test Matrix

```text
Test Files  208 passed | 9 skipped (217)
     Tests  2819 passed | 47 skipped (2866)
```

Expected stderr:

- Some lifecycle/plugin tests log intentional degraded-mode database warnings because no local `DATABASE_URL` is configured.
- Negative-path auth/plugin tests log expected errors while asserting controlled responses.

### OpenAPI Parity

```text
> metasheet-v2@2.5.0 verify:multitable-openapi:parity /private/tmp/ms2-system-fields-backend-20260430
> pnpm exec tsx packages/openapi/tools/build.ts && node --test scripts/ops/multitable-openapi-parity.test.mjs

✔ multitable openapi stays aligned with runtime contracts (0.59625ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### OpenAPI Security Validation

```text
OpenAPI security validation passed
```

### Whitespace

```text
git diff --check
# clean
```

## Assertions Covered

- Query service injects `createdTime`, `modifiedTime`, `createdBy`, and `modifiedBy` values from record metadata.
- Metadata projection overrides forged JSON values for system field IDs.
- `RecordWriteService.patchRecords()` writes `modified_by` using the actor.
- `RecordService.createRecord()` keeps `created_by` and `modified_by` aligned at creation.
- `RecordService.patchRecord()` writes `modified_by` using `actorId ?? access.userId`.
- OpenAPI field type enum includes the four system field types.

## CI Verification

After force-pushing the CI-failure fix, GitHub CI should cover:

- migration replay with `zzzz20260430163000_add_meta_record_modified_by.ts`
- full backend unit/integration matrix
- OpenAPI contract matrix

## Deferred

`autoNumber` is intentionally not claimed by this verification. It requires persistent sequence allocation and should be delivered as a follow-up slice.
