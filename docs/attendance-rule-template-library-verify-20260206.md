# Attendance Rule Template Library UI Verification (2026-02-06)

## Environment
- Frontend: local Vite dev server
- API: proxied to `http://142.171.239.56:8081` via `VITE_API_BASE`
- URL: `http://localhost:8901/p/plugin-attendance/attendance`
- Auth: localStorage `auth_token` (admin)

## Steps
1. Start frontend with proxy:
   - `VITE_API_BASE=http://142.171.239.56:8081 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
2. Open Attendance page in Playwright.
3. Inject admin token into localStorage and reload:
   - `localStorage.setItem('auth_token', '<ADMIN_TOKEN>')`
4. Scroll to admin console section.
5. Verify the **Rule Template Library** section renders with:
   - System templates (read-only)
   - Library templates (JSON)
   - Copy/Save buttons

## Evidence
- Playwright snapshot: `.playwright-cli/page-2026-02-06T04-10-05-052Z.yml`
  - Contains heading `Rule Template Library`.
- Screenshot (viewport): `output/playwright/attendance-rule-templates-viewport.png`

## Result
- ✅ Rule Template Library section rendered in attendance admin console.
- ✅ UI controls present (reload, copy, save).

## Notes
- Using `VITE_API_BASE` keeps API requests same-origin to the Vite proxy, avoiding CORS issues.
