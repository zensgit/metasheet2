# Attendance Product Shell Verification (2026-02-07)

## Scope
Verify the "attendance-only focused shell" UI refactor and its capability-driven behavior:

1. `/` dynamic landing (attendance-focused -> `/attendance`)
2. Top nav focus mode (attendance-only shows Attendance only)
3. Attendance tabs:
   - Overview (default)
   - Admin Center (admin only)
   - Workflow Designer (workflow capability only)
4. Mobile policy:
   - admin/workflow tabs gated with "Desktop recommended"
5. Regression:
   - Frontend build passes
   - Frontend unit tests pass
   - UI acceptance scripts support feature/mode injection

## Build / Tests

### Build
Command:
```bash
pnpm --filter @metasheet/web build
```
Result: **PASS** (vite build succeeded).

### Unit Tests
Command:
```bash
pnpm --filter @metasheet/web exec vitest run --watch=false
```
Result: **PASS** (26 tests).

Note:
- Vitest prints a Vite WebSocket `EPERM` listen error for `0.0.0.0:24678` in this environment, but tests still complete and pass.

## UI Automation
Script:
- `scripts/verify-attendance-import-ui.mjs`
- `scripts/verify-attendance-full-flow.mjs`

New supported envs:
- `PRODUCT_MODE` (e.g. `attendance`)
- `FEATURES_JSON` (JSON string stored into `localStorage.metasheet_features`)
- `UI_MOBILE=true` (mobile viewport)
- `ALLOW_EMPTY_RECORDS=true` (do not fail when Records is empty)

### Scenario A: Attendance-only focus mode
```bash
WEB_URL=http://localhost:8899/attendance \
AUTH_TOKEN="<token>" \
PRODUCT_MODE=attendance \
FEATURES_JSON='{"attendance":true,"workflow":false,"attendanceAdmin":true,"attendanceImport":true,"mode":"attendance"}' \
ALLOW_EMPTY_RECORDS=true \
USER_IDS="<userId>" \
node scripts/verify-attendance-import-ui.mjs
```
Expected:
- Tabs show `Overview` and `Admin Center` (admin capability).
- No `Workflow Designer` tab.
- Records table loads (or allowed empty if configured).

### Scenario B: Attendance + Workflow
```bash
WEB_URL=http://localhost:8899/attendance \
AUTH_TOKEN="<token>" \
PRODUCT_MODE=attendance \
FEATURES_JSON='{"attendance":true,"workflow":true,"attendanceAdmin":true,"attendanceImport":true,"mode":"attendance"}' \
ALLOW_EMPTY_RECORDS=true \
USER_IDS="<userId>" \
node scripts/verify-attendance-import-ui.mjs
```
Expected:
- `Workflow Designer` tab is present.

### Scenario C: Mobile gating
```bash
WEB_URL=http://localhost:8899/attendance \
AUTH_TOKEN="<token>" \
PRODUCT_MODE=attendance \
FEATURES_JSON='{"attendance":true,"workflow":true,"attendanceAdmin":true,"attendanceImport":true,"mode":"attendance"}' \
UI_MOBILE=true \
ALLOW_EMPTY_RECORDS=true \
USER_IDS="<userId>" \
node scripts/verify-attendance-import-ui.mjs
```
Expected:
- When clicking `Workflow Designer` tab, page shows **Desktop recommended** gate.

### Scenario D: Full Flow Smoke (Root -> Attendance -> Tabs)
```bash
WEB_URL=http://localhost:8899/ \
AUTH_TOKEN="<token>" \
PRODUCT_MODE=attendance \
FEATURES_JSON='{"attendance":true,"workflow":true,"attendanceAdmin":true,"attendanceImport":true,"mode":"attendance"}' \
ALLOW_EMPTY_RECORDS=true \
OUTPUT_DIR=output/playwright/attendance-full-flow \
node scripts/verify-attendance-full-flow.mjs
```
Expected:
- `/` redirects to `/attendance`
- Attendance-focused nav shows no `Grid`
- Overview loads and records reload completes
- Admin/Workflow screenshots exist under `output/playwright/attendance-full-flow/`

## Executed Results (This Workspace)
Completed runs on **2026-02-07**:

1. Frontend build: **PASS**
   - `pnpm --filter @metasheet/web build`
2. Frontend tests: **PASS**
   - `pnpm --filter @metasheet/web exec vitest run --watch=false`
3. Backend unit tests: **PASS**
   - `cd packages/core-backend && pnpm exec vitest run tests/unit --reporter=dot`
4. Playwright full flow (local Vite dev server, attendance-focused, desktop): **PASS**
   - Output: `output/playwright/attendance-full-flow-local/attendance-focused/`
5. Playwright full flow (local Vite dev server, attendance-focused, mobile): **PASS**
   - Output: `output/playwright/attendance-full-flow-local/mobile/`
6. Playwright full flow (remote preprod, platform mode): **PASS**
   - Output: `output/playwright/attendance-full-flow-remote/platform/`

Notes:
- If port `8899` is occupied, Vite will pick another port (for example `8901`). Update `WEB_URL` accordingly.
- The remote preprod UI will only show the attendance-focused nav **after** it is deployed with this branch (or any build that includes the product shell changes). Until then, only the platform-mode smoke applies.

## Manual Spot Checks (Optional)
In browser DevTools:
```js
localStorage.setItem('metasheet_product_mode', 'attendance')
localStorage.setItem('metasheet_features', JSON.stringify({
  attendance: true,
  workflow: false,
  attendanceAdmin: true,
  attendanceImport: true,
  mode: 'attendance',
}))
location.reload()
```
Expected:
- Top nav shows only `Attendance`
- Landing on `/` goes to `/attendance`

## Known Limitations
- Backend `data.features` currently uses env-driven `PRODUCT_MODE` (defaults to `platform` unless explicitly set).
- Workflow designer is embedded as-is (ElementPlus + BPMN.js). UX polish (multi-workflow list/publish history) is out of scope for this iteration.
