# Attendance On-Prem New-Server UAT Runbook (2026-03-07)

## Scope

- Target: Windows Server + WSL2 on-prem deployment.
- Package source: Release `v2.5.1-onprem-20260307-current`.
- Goal: complete production-readiness UAT for attendance-only mode.

## Inputs (fill before execution)

- `WINDOWS_SERVER_IP=<...>`
- `WSL_DISTRO=<...>` (example: `Ubuntu-22.04`)
- `ADMIN_EMAIL=<...>`
- `ADMIN_PASSWORD=<...>`

## Step 1: Download and verify package

On operator machine:

```bash
gh release download v2.5.1-onprem-20260307-current \
  --repo zensgit/metasheet2 \
  --pattern 'metasheet-attendance-onprem-v2.5.0-20260307-current*' \
  --pattern 'SHA256SUMS' \
  -D output/playwright/onprem/v2.5.1-onprem-20260307-current
```

```bash
cd output/playwright/onprem/v2.5.1-onprem-20260307-current
shasum -a 256 -c SHA256SUMS
```

## Step 2: WSL deploy (copy-execute)

Follow the exact commands in:

- `docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md`
- `docs/deployment/attendance-windows-wsl-onprem-20260306.md`

Mandatory post-install checks:

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env REQUIRE_ATTENDANCE_ONLY=1 scripts/ops/attendance-onprem-env-check.sh
SERVICE_MANAGER=auto CHECK_NGINX=1 scripts/ops/attendance-onprem-healthcheck.sh
```

## Step 3: Functional UAT (attendance core)

Open:

- `http://<WINDOWS_SERVER_IP>/attendance`

Checklist:

1. Admin login succeeds and opens attendance-only shell.
2. Check in/out works for employee account.
3. Adjustment request submit/approve/reject works.
4. Import upload + preview + commit works.
5. Summary/records/report load without API errors.
6. Mobile view shows core flow and desktop-only gating text where expected.

## Step 4: Sign-off artifacts

Capture and store:

- Browser screenshots for each checklist item.
- Healthcheck outputs.
- Final signed template:
  - `docs/deployment/attendance-uat-signoff-template-20260306.md`
- Go-live checklist:
  - `docs/deployment/attendance-go-live-checklist-20260306.md`

## Status record (this turn)

- Package build/release verification: complete (`run #22798975422`).
- New-server execution: pending actual server access and operator input values.
