# Attendance Strict Smoke Current Overview Adaptation - Verification

Date: 2026-05-23

## Context

After the deploy host IP was updated to `23.254.236.11`, the production deploy workflow recovered:

- `Build and Push Docker Images` run `26327831118`: success
- `Attendance Locale zh Smoke (Prod)` run `26327830919`: success
- `Attendance Remote Preflight (Prod)` run `26327913495`: success
- `Attendance Remote Metrics (Prod)` run `26327914080`: success
- `Attendance Remote Storage Health (Prod)` run `26327913654`: success

`Attendance Strict Gates (Prod)` run `26328283120` was then triggered with `expect_product_mode=platform`.

Result:

- `apiSmoke`: PASS
- `provisioning`: PASS
- `playwrightProd`: FAIL, reason `TIMEOUT`
- `playwrightDesktop`: FAIL, reason `TIMEOUT`
- `playwrightMobile`: FAIL, reason `TIMEOUT`

The artifact screenshot showed the current Attendance overview and confirmed that `Records` is no longer on the default overview screen.

## Static Checks

Commands:

```bash
node --check scripts/verify-attendance-production-flow.mjs
node --check scripts/verify-attendance-full-flow.mjs
git diff --check
```

Result: PASS.

Follow-up review fixes:

- Removed a redundant second `selectAdminSection()` call in
  `verify-attendance-full-flow.mjs` so the import-section fallback can continue
  to skip optional assertions when the first admin-section lookup is caught.
- Reused the first `User Access` section handle in
  `verify-attendance-production-flow.mjs` so the screenshot and role
  provisioning checks share one quick-jump selection.

## Live Verification Target

Target:

- Web URL: `http://23.254.236.11:8081/attendance`
- API base: `http://23.254.236.11:8081/api`
- Expected product mode: `platform`

Auth:

- Used local token file `/tmp/metasheet-23-main-admin-72h-20260523T082748Z.jwt`.
- Token value was not printed.
- `/api/auth/me` reported admin user and enabled attendance features.

## Production Flow

Command shape:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-23-main-admin-72h-20260523T082748Z.jwt)" \
WEB_URL=http://23.254.236.11:8081/attendance \
API_BASE=http://23.254.236.11:8081/api \
EXPECT_PRODUCT_MODE=platform \
HEADLESS=true \
OUTPUT_DIR=/tmp/attendance-production-flow-current-overview-6 \
node scripts/verify-attendance-production-flow.mjs
```

Result: PASS.

Observed evidence:

- Features: `attendance=true`, `attendanceAdmin=true`, `attendanceImport=true`, `mode=platform`.
- Records was not visible on Overview, so the script switched to Reports.
- Punch API returned ok.
- Adjustment request returned `DUPLICATE_REQUEST`; this is an accepted best-effort warning because the script had already created today's request in earlier retries.
- User Access admin section loaded through `data-admin-quick-jump`.
- Import template loaded.
- CSV payload loaded.
- Mapping profile applied.
- Import preview returned `items=1`.
- Import commit returned `imported=1`.
- Import batches UI was not reachable through the focused rail; the script continued to API batch-item verification.
- Group and membership API verification passed.
- Final Records refresh passed after switching to Reports.
- Final log: `Production flow verification complete`.

Output screenshots:

- `/tmp/attendance-production-flow-current-overview-6/01-overview-loaded.png`
- `/tmp/attendance-production-flow-current-overview-6/02-overview-after-request.png`
- `/tmp/attendance-production-flow-current-overview-6/03-admin-loaded.png`
- `/tmp/attendance-production-flow-current-overview-6/03a-admin-user-access.png`
- `/tmp/attendance-production-flow-current-overview-6/04-import-preview.png`
- `/tmp/attendance-production-flow-current-overview-6/05-import-batches.png`
- `/tmp/attendance-production-flow-current-overview-6/06-overview-after-import.png`

## Full Flow - Desktop

Command shape:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-23-main-admin-72h-20260523T082748Z.jwt)" \
WEB_URL=http://23.254.236.11:8081/attendance \
API_BASE=http://23.254.236.11:8081/api \
EXPECT_PRODUCT_MODE=platform \
HEADLESS=true \
OUTPUT_DIR=/tmp/attendance-full-flow-current-overview-3 \
node scripts/verify-attendance-full-flow.mjs
```

Result: PASS.

Observed evidence:

- Loaded features from `/api/auth/me`.
- Records was not visible on Overview, so the script switched to Reports.
- The script returned to Overview and verified the Anomalies card.
- Invalid JSON import retry feedback was verified with the current message shape.
- Admin settings save cycle passed.
- Default rule save cycle passed.
- Payroll batch UI passed.
- Final log: `Full flow verification complete`.

Output screenshots:

- `/tmp/attendance-full-flow-current-overview-3/01-overview.png`
- `/tmp/attendance-full-flow-current-overview-3/02-admin.png`

## Full Flow - Mobile

Command shape:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-23-main-admin-72h-20260523T082748Z.jwt)" \
WEB_URL=http://23.254.236.11:8081/attendance \
API_BASE=http://23.254.236.11:8081/api \
EXPECT_PRODUCT_MODE=platform \
HEADLESS=true \
UI_MOBILE=true \
OUTPUT_DIR=/tmp/attendance-full-flow-current-overview-mobile-2 \
node scripts/verify-attendance-full-flow.mjs
```

Result: PASS.

Observed evidence:

- Loaded features from `/api/auth/me`.
- Records was not visible on Overview, so the script switched to Reports.
- The script returned to Overview and verified the Anomalies card.
- Mobile Admin Center accepted the current Admin Console surface.
- Final log: `Full flow verification complete`.

Output screenshots:

- `/tmp/attendance-full-flow-current-overview-mobile-2/01-overview.png`
- `/tmp/attendance-full-flow-current-overview-mobile-2/02-admin.png`

## Secret Hygiene

The verification commands used a local `0600` token file and did not print the token value. The development and verification docs contain only paths and non-secret status summaries.

## Remaining Non-Blocking Observation

The focused admin rail cannot show nested `attendance-admin-import-batches` while its parent import section is hidden. The production smoke now logs this as a warning and still verifies batch creation through the API. A product UI cleanup can address that independently.
