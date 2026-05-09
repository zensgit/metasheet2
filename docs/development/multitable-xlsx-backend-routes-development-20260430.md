# Multitable XLSX Backend Routes Development - 2026-04-30

## Scope

Phase 2 closes the RC P0 gap where XLSX support existed only in the browser. This slice adds server-side XLSX import/export routes under the existing multitable API without changing the frontend flow yet.

## Baseline

- Branch: `codex/multitable-xlsx-backend-routes-20260430`
- Base: `origin/main@b3ff3d4cf`
- Rebase: rebased onto `origin/main@358a8ea24` before push/PR.
- Worktree: `/tmp/ms2-xlsx-backend-routes-20260430`
- Root checkout was intentionally not touched because it contains unrelated public-form/DingTalk work.

## Design

- Backend dependency policy: `xlsx` is now an explicit `@metasheet/core-backend` runtime dependency. This avoids relying on the web package dependency through workspace hoisting.
- XLSX parsing/export lives in `packages/core-backend/src/multitable/xlsx-service.ts`.
- Import route: `POST /api/multitable/sheets/:sheetId/import-xlsx`.
- Export route: `GET /api/multitable/sheets/:sheetId/export-xlsx`.
- Import accepts multipart `file`, optional `sheetName`, and optional JSON `mapping` form field.
- Export returns `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with `X-MetaSheet-XLSX-Truncated`.

## Write Path

- Import does not write `meta_records` directly.
- Each imported row is passed to `RecordService.createRecord()`.
- That preserves the existing create semantics: `canCreateRecord`, field validation, select/multiSelect/link/attachment guards, realtime publish, eventBus emit, and post-commit hooks.
- Readonly, hidden, formula, lookup, and rollup fields are excluded from auto-mapping and rejected in explicit mappings.

## Read Path

- Export uses `resolveSheetReadableCapabilities()`.
- Export requires `access.userId`, `capabilities.canRead`, and `capabilities.canExport`.
- Visible fields only are exported; field-level hidden properties are excluded.
- Optional `viewId` is verified to belong to the target sheet. This route does not yet apply saved view filter/sort semantics; it is a sheet export with a view ownership guard.

## Files Changed

- `packages/core-backend/package.json`
- `pnpm-lock.yaml`
- `packages/core-backend/src/multitable/xlsx-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/multitable-xlsx-service.test.ts`
- `packages/core-backend/tests/integration/multitable-xlsx-routes.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/multitable.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`

## Deferred

- Frontend still uses the existing browser-side XLSX import/export flow. A follow-up can switch it to the new backend routes for full-sheet server export and server-side import batching.
- Export does not yet apply saved view filter/sort rules. It verifies `viewId` scope only.
