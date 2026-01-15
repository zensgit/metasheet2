# Grid Save & A11y Verification (2026-01-13)

## Scope
- Frontend Grid view save flow
- Legacy `/api/spreadsheet` compatibility endpoint
- Plugin list fetch handling
- A11y warnings for form inputs

## Changes Applied
- Added `id`/`name` attributes to Grid inputs to clear a11y warnings.
  - `apps/web/src/views/GridView.vue`
- Made plugin list parsing tolerant of `{ list, summary }` response.
  - `apps/web/src/composables/usePlugins.ts`
- Re-added legacy endpoint for Grid save/load.
  - `packages/core-backend/src/routes/spreadsheets.ts`

## Test Environment
- Backend: `http://127.0.0.1:7778`
- Frontend: `http://127.0.0.1:8899`
- DB: `metasheet_v2`
- Flags: `RBAC_TOKEN_TRUST=true`, `SKIP_PLUGINS=true`

## Verification Steps
1. Start backend:
   - `DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 RBAC_TOKEN_TRUST=true SKIP_PLUGINS=true JWT_SECRET=dev-secret-key PORT=7778 pnpm --filter @metasheet/core-backend dev:core`
2. Start frontend:
   - `pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
3. Open Grid:
   - `http://127.0.0.1:8899/grid`
4. Click **保存**.
5. Check Network:
   - `POST /api/spreadsheet` returns **200**.
6. Check Console:
   - No a11y warnings for missing input `id`/`name`.
   - No `plugins.value.some` errors.

## Results
- ✅ Grid save succeeded; `POST /api/spreadsheet` returned 200.
- ✅ Legacy `/api/spreadsheet` endpoint responds.
- ✅ Plugin list fetch no longer errors on response shape.
- ✅ A11y warning about missing `id`/`name` cleared.

## Notes
- Older 404s were due to missing legacy route; fixed in `spreadsheets.ts`.
- If console warnings return, re-check `GridView.vue` input attributes and `usePlugins` parsing.
