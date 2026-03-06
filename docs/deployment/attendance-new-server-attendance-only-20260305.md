# Attendance New Server Deployment (Attendance-Only Shell)

This runbook is for deploying MetaSheet Attendance to a **new server** while hiding non-attendance modules.

If you need a **no-Docker** path (for Windows Server + Ubuntu VM local deployment), use:

- `docs/deployment/attendance-windows-onprem-no-docker-20260306.md`

## 1) Environment

Edit `docker/app.env` on the target server:

```env
NODE_ENV=production
PRODUCT_MODE=attendance
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/app/uploads/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000
```

Notes:
- `PRODUCT_MODE=attendance` enables attendance-focused shell.
- Non-attendance navigation entries are hidden in frontend shell and route guard redirects non-allowed pages to `/attendance`.

## 2) Deploy

Use the production deploy script:

```bash
scripts/ops/deploy-attendance-prod.sh
```

The script enforces attendance-only mode through preflight by default:
- `REQUIRE_ATTENDANCE_ONLY=1` (default)
- internal preflight flag: `ATTENDANCE_PREFLIGHT_REQUIRE_PRODUCT_MODE_ATTENDANCE=1`
- Deployment fails fast if `PRODUCT_MODE` is missing/not `attendance`.

## 3) Verify

Run preflight and strict gates:

```bash
scripts/ops/attendance-preflight.sh
API_BASE="http://<HOST>:8081/api" AUTH_TOKEN="<ADMIN_JWT>" scripts/ops/attendance-run-gates.sh
```

Functional checks:
- `GET /api/auth/me` contains:
  - `features.mode = "attendance"`
  - `features.attendance = true`
- Open `http://<HOST>:8081/attendance`:
  - top nav shows attendance-focused entry only
  - visiting `/grid` or `/spreadsheets` redirects back to `/attendance`

## 4) Restore Full Shell Later

To re-enable full MetaSheet modules:

1. Set `PRODUCT_MODE=platform` in `docker/app.env`.
2. Redeploy with attendance-only guard disabled:

```bash
REQUIRE_ATTENDANCE_ONLY=0 scripts/ops/deploy-attendance-prod.sh
```

3. Re-run strict gates and UI smoke.
