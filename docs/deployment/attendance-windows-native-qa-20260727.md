# Attendance Windows Native Internal QA

This runbook starts the packaged attendance preview directly on Windows. It
does not require WSL2, Docker, IIS, or nginx.

This path is for isolated internal QA only. It is not customer UAT, a release,
a deployment authorization, or permission to enable rollout flags.

## 1. Prerequisites

- Windows 11 or Windows Server 2022 x64
- Node.js 20 x64
- pnpm 9 or newer
- PM2 installed with `npm install --global pm2`
- PostgreSQL on the same Windows machine
- PostgreSQL client tools (`psql.exe`)
- optional: a Redis-compatible service for Redis-specific test cases

PostgreSQL must run on the QA machine and the database name must be exactly
`metasheet_windows_qa`. The launcher rejects remote database hosts and every
other database name before migrations. The optional Redis-compatible service
may run on the QA machine or on an isolated internal test network. The default
launcher does not require Redis.

## 2. Verify and extract

Verify the SHA-256 value published with the QA issue:

```powershell
Get-FileHash .\metasheet-attendance-onprem-*.zip -Algorithm SHA256
```

Extract the ZIP to a short path without spaces, for example:

```text
C:\metasheet-attendance-qa
```

## 3. Configure

From an Administrator PowerShell:

```powershell
cd C:\metasheet-attendance-qa
Copy-Item `
  .\docker\app.env.attendance-windows-native.qa.example `
  .\docker\app.env
notepad .\docker\app.env
```

Replace all three `change-me` values. Create a fresh, empty local database
named exactly `metasheet_windows_qa`. Keep these defaults unless a port is
already reserved:

```text
HOST=127.0.0.1
PORT=8900
WINDOWS_NATIVE_GATEWAY_HOST=127.0.0.1
WINDOWS_NATIVE_GATEWAY_PORT=8080
```

Do not add real DingTalk, Feishu, webhook, email, or customer credentials.
Do not enable attendance rollout flags.

The preflight enforces this boundary: the backend, gateway, and PostgreSQL must
use loopback; the database name must be `metasheet_windows_qa`; the gateway may
proxy only the package-local HTTP backend; attendance opt-ins outside the
import settings are rejected case-insensitively; and external delivery or
integration configuration is rejected.

## 4. Preflight and start

```powershell
.\windows-native-preflight.bat
.\windows-native-start.bat
```

If the package is already running, use `windows-native-stop.bat` before
starting it again. A failed start removes only the backend and gateway
processes created by that attempt.

The start command performs:

1. package and dependency preflight;
2. PostgreSQL TCP check;
3. `pnpm install --frozen-lockfile` on the first run;
4. database migrations;
5. backend startup through PM2;
6. the package-owned static/proxy gateway startup;
7. `/health` and `/attendance` probes.

Open:

```text
http://127.0.0.1:8080/attendance
```

## 5. Create the synthetic QA administrator

After the first successful start:

```powershell
.\windows-native-bootstrap-admin.bat `
  qa-admin@example.invalid `
  "Use-A-Unique-Password-For-QA" `
  "QA Administrator"
```

The helper uses the package database, grants the existing attendance admin
permissions, and verifies login through the package gateway. Never reuse a
customer or production password.

## 6. Health and logs

```powershell
.\windows-native-healthcheck.bat
pm2 status
pm2 logs metasheet-backend
pm2 logs metasheet-windows-gateway
```

Logs are also written under:

```text
output\logs\
```

## 7. Stop

```powershell
.\windows-native-stop.bat
```

This stops only `metasheet-backend` and `metasheet-windows-gateway`. It does
not stop PostgreSQL or Redis.

## 8. QA boundary

Run only the cases marked READY in the internal QA issue. Use synthetic
organizations, users, shifts, punches, approvals, and notification failures.
Record the package SHA, case ID, fixture IDs, expected result, actual result,
screenshots or logs, and database residue.
