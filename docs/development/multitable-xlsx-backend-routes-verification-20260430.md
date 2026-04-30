# Multitable XLSX Backend Routes Verification - 2026-04-30

## Summary

Phase 2 focused backend verification is green. Coverage includes XLSX parse/export helpers, import mapping, invalid file handling, permission denial, export response headers, visible-field export filtering, OpenAPI generation, and backend TypeScript build.

## Commands

```bash
pnpm install --lockfile-only --filter @metasheet/core-backend
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-xlsx-service.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-xlsx-routes.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm exec tsx packages/openapi/tools/build.ts
pnpm exec tsx packages/openapi/tools/validate.ts
git diff --check
```

## Results

- `multitable-xlsx-service.test.ts`: 5/5 passed.
- `multitable-xlsx-routes.test.ts`: 4/4 passed.
- `@metasheet/core-backend build`: passed.
- `packages/openapi/tools/build.ts`: regenerated `openapi.yaml`, `openapi.json`, and `combined.openapi.yml`.
- `packages/openapi/tools/validate.ts`: OpenAPI security validation passed.
- `git diff --check`: passed.

## Rebase Verification

After rebasing onto `origin/main@358a8ea24`, the same focused gate was rerun:

- `git diff --check`: passed.
- `@metasheet/core-backend build`: passed.
- `multitable-xlsx-service.test.ts`: 5/5 passed.
- `multitable-xlsx-routes.test.ts`: 4/4 passed.
- `packages/openapi/tools/validate.ts`: OpenAPI security validation passed.

## Tested Cases

- XLSX buffer round-trip produces expected headers and rows.
- Auto-mapping ignores hidden and readonly/computed fields.
- Explicit mapping to non-importable fields is rejected.
- Import route creates records through `RecordService.createRecord()` instead of direct SQL.
- Invalid XLSX-like input is rejected before `INSERT INTO meta_records`.
- Import is denied without create permission.
- Export route returns XLSX content type and attachment filename.
- Export excludes hidden fields from workbook headers and rows.

## Known Limitations

- Server export currently exports sheet rows, not saved view filter/sort results.
- Frontend still uses browser-side XLSX until a follow-up routes UI actions through these endpoints.
