# Wave M-Feishu-4 Multi-Select Field Verification — 2026-04-29

## Summary

The `multiSelect` slice was verified with focused backend unit tests,
frontend component tests, backend build, and frontend type-check.

## Commands

Rebased cleanly onto `origin/main@f76a105f7` before the final verification
pass.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-field-types-batch1.test.ts \
  tests/unit/field-validation.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/record-service.test.ts \
  --reporter=dot
```

Result: 4 files passed, 178 tests passed.

Notes: `record-write-service.test.ts` intentionally logs existing
post-commit-hook failure warnings for tests that assert hook errors are
best-effort and do not fail the write.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-multiselect-field.spec.ts \
  tests/multitable-field-manager.spec.ts \
  --watch=false \
  --reporter=dot
```

Result: 2 files passed, 18 tests passed.

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: both completed with exit code 0.

OpenAPI contract follow-up after PR CI caught generated artifact drift:

```bash
pnpm exec tsx packages/openapi/tools/build.ts
./scripts/ops/attendance-run-gate-contract-case.sh openapi
```

Result: `packages/openapi/dist/{combined.openapi.yml,openapi.json,openapi.yaml}`
were regenerated and the OpenAPI contract case completed with exit code 0
after the generated outputs were committed.

## Coverage

- `mapFieldType()` recognizes `multiSelect`, `multiselect`,
  `multi-select`, and `multi_select`.
- Field property sanitization preserves options and validation config.
- `serializeFieldRow()` exposes `multiSelect` with options.
- `normalizeMultiSelectValue()` de-duplicates arrays, treats empty input as
  empty selection, and rejects scalars/unknown options.
- `RecordWriteService.validateChanges()` rejects scalar and invalid
  multi-select values while allowing valid arrays.
- `RecordService.createRecord()` and `patchRecord()` persist normalized
  arrays.
- Frontend renderer shows selected values as chips.
- Cell editor, form view, and record drawer emit array payloads.
- Field manager creates configured `multiSelect` fields with select-style
  options.
- OpenAPI source and generated dist artifacts expose `multiSelect` in field
  create/update schemas.

## Remaining Limits

- Kanban grouping by `multiSelect` remains intentionally deferred.
- Shortcut `query-service.ts` scalar filters remain unchanged; view-level
  `filterInfo` supports array matching through normal string/array evaluation.
- No full workspace validation was run in this worktree.
