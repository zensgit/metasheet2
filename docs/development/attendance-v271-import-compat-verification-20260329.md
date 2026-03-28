# Attendance v2.7.1 Import Compatibility Verification

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Verified scope

- `fileId` alias compatibility for uploaded CSV preview/commit flows
- CSV content negotiation on `/api/attendance/import/template`

## Commands

### Focused backend integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "serves attendance import templates as JSON and CSV|supports CSV upload channel via fileId/csvFileId aliases and cleans up after sync commit|accepts fileId alias and defaults uploaded CSV imports to the daily summary profile" --reporter=dot
```

Result: pass

Notes:

- `3 passed`
- `GET /api/attendance/import/template` keeps JSON by default and returns CSV when `Accept: text/csv`
- sync preview/commit accept the upload response's `fileId` alias in addition to `csvFileId`
- template JSON now exposes `defaultProfileId`, `csvTemplateUrl`, and `csvTemplateFilename` so callers can discover the recommended CSV profile without hardcoding route rules

### Backend type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: pass

### Source integrity

```bash
git diff --check
```

Result: pass
