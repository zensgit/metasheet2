# Attendance Rule Template Library Verification (2026-02-06)

## Environment
- Frontend: local Vite dev server
- Backend: local dev server `http://localhost:8902`
- Database: `metasheet-dev-postgres` (port 5435)
- URL: `http://localhost:8901/p/plugin-attendance/attendance`
- Auth: localStorage `auth_token` (admin)

## Migration
Executed:
- `DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/metasheet pnpm --filter @metasheet/core-backend migrate`

Result:
- Migration `zzzz20260206141000_create_attendance_template_versions` executed successfully.

## UI Verification (Playwright)
1. Start frontend with proxy:
   - `VITE_API_BASE=http://142.171.239.56:8081 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
2. Open Attendance page in Playwright.
3. Inject admin token into localStorage and reload.
4. Verify **Rule Template Library** section renders with:
   - System templates (read-only)
   - Library templates (JSON)
   - Copy/Save buttons
5. Verify **Template Versions** table renders with Restore action.

Evidence:
- `output/playwright/attendance-rule-templates-snapshot.yml`
- `output/playwright/attendance-rule-templates-viewport.png`

## API Verification (Local Dev Server)
Auth token (dev server uses fallback secret):
- JWT secret: `fallback-development-secret-change-in-production`
- User: `0cdf4a9c-4fe1-471b-be08-854b683dc930` (admin)

Requests:
1. `PUT /api/attendance/rule-templates` with empty library
   - Result: ✅ `ok: true`
2. `GET /api/attendance/rule-templates`
   - Result: ✅ `versions = 1`
3. `POST /api/attendance/rule-templates/restore` with `versionId=7f2f1934-6964-49f1-8f6b-e0f589e6a50a`
   - Result: ✅ `ok: true`
4. `GET /api/attendance/rule-templates`
   - Result: ✅ `versions = 2` and latest `sourceVersionId` populated

## Result
- ✅ Version table created and populated
- ✅ Rule template save creates a version snapshot
- ✅ Restore creates a new version snapshot referencing the source version
- ✅ UI shows template library and versions

## Notes
- The runtime container `metasheet-dev-backend` still runs older code; validation used a local dev server on port 8902.
