# Attendance Windows Native Exact-SHA QA v2 (Draft / HOLD)

**Status: Draft / HOLD**

This runbook prepares Windows-native internal QA against the exact source SHA:

```text
0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b
```

It does **not** authorize deployment, staging soak, customer UAT, feature-flag
enablement, external notifications, production access, or issue closure.

Old W4C-2 package claims (for example `8dfde5a7…`, `66a98035…`) are **stale**
and must not be reused as current evidence for this v2 campaign.

## 1. Scope

- Isolated internal QA only
- Synthetic organizations, users, shifts, punches, and failures only
- Dedicated local database name: `metasheet_windows_qa`
- Loopback-only backend, gateway, and PostgreSQL
- Risk matrix cases: PQA-01 … PQA-10

## 2. Prerequisites

- Windows 11 or Windows Server 2025 x64
- Node.js 20 x64
- pnpm 9 or newer
- PM2 (`npm install --global pm2`)
- PostgreSQL on the same Windows machine, including `psql.exe`
- Optional Redis-compatible service for Redis-specific probes

The launcher rejects remote database hosts and every database name other than
`metasheet_windows_qa` before migrations.

## 3. Verify package identity

Confirm the package SHA-256, then confirm the embedded exact source SHA:

```powershell
Get-FileHash .\metasheet-attendance-onprem-*.zip -Algorithm SHA256
Get-Content .\SOURCE_SHA
Get-Content .\QA_TOOLING_SHA
Get-Content .\attendance-windows-native-qa-v2.pin.json
```

`SOURCE_SHA` and the pin `expectedSourceSha` must both equal
`0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`. Preflight fails closed on mismatch.
`QA_TOOLING_SHA` identifies the separately reviewed packaging and Windows QA
tooling revision. It may differ from `SOURCE_SHA`; the CI build first proves
that all listed product-runtime paths are byte-identical to `SOURCE_SHA`, then
records the exact tooling revision in both the package file and manifest.

Extract the ZIP to a short path without spaces, for example:

```text
C:\metasheet-attendance-qa-v2
```

## 4. Configure

From an Administrator PowerShell:

```powershell
cd C:\metasheet-attendance-qa-v2
Copy-Item `
  .\docker\app.env.attendance-windows-native.qa.example `
  .\docker\app.env
notepad .\docker\app.env
```

Replace every `change-me` value. Create a fresh empty local database named
exactly `metasheet_windows_qa`. Keep loopback defaults unless a port is already
reserved:

```text
HOST=127.0.0.1
PORT=8900
WINDOWS_NATIVE_GATEWAY_HOST=127.0.0.1
WINDOWS_NATIVE_GATEWAY_PORT=8080
```

Do not add real DingTalk, Feishu, webhook, email, or customer credentials.
Do not enable attendance rollout flags.

## 5. Preflight and start

```powershell
.\windows-native-preflight.bat
.\windows-native-start.bat
```

If the package is already running, use `windows-native-stop.bat` before starting
again. A failed start removes only the backend and gateway processes created by
that attempt.

Open:

```text
http://127.0.0.1:8080/attendance
```

## 6. Synthetic administrator

```powershell
.\windows-native-bootstrap-admin.bat `
  qa-admin@example.invalid `
  "Use-A-Unique-Password-For-QA" `
  "QA Administrator"
```

Never reuse a customer or production password.

## 7. Risk matrix runner

The matrix is runnable without inventing product PASS. Without host evidence it
honestly reports `BLOCKED` for PQA-01..10 with `residue=null` (not measured):

```powershell
node .\scripts\ops\attendance-windows-native-qa-runner.mjs --root .
```

Host evidence, when collected, must live in a local evidence directory as
`summary.json` bound to the exact source SHA above. Stale package SHAs are
rejected. PASS requires `syntheticDataOnly=true`, `residue=0`,
`isolatedDatabase=true`, `databaseName=metasheet_windows_qa`,
`hostPlatform=windows`, a `windowsPowerShellVersion` in the 5.1 line,
`customerOrExternalDestination=false`, and `externalNotificationsSent=false`.
Missing safety facts stay `BLOCKED`; an explicitly unsafe destination or
notification is `FAIL`.

### Case list

| ID | Focus | Default without host evidence |
| --- | --- | --- |
| PQA-01 | Multi-segment authoring | BLOCKED |
| PQA-02 | Overnight attribution | BLOCKED |
| PQA-03 | Timezone validation | BLOCKED |
| PQA-04 | Legacy compatibility | BLOCKED |
| PQA-05 | Shadow posture | BLOCKED |
| PQA-06 | Ambiguous evidence | BLOCKED |
| PQA-07 | Auth isolation | BLOCKED |
| PQA-08 | Fingerprint freeze | BLOCKED |
| PQA-09 | Outbox retry | BLOCKED |
| PQA-10 | Scheduled identity/outcome/outbox re-evaluation | BLOCKED |

PQA-10 is re-opened for evaluation on the current SHA because scheduled
identity/outcome/outbox code is present. That is not a PASS. Do not invent PASS
from unit/integration suites alone or from the old package.

## 8. Health, logs, stop

```powershell
.\windows-native-healthcheck.bat
pm2 status
pm2 logs metasheet-backend
pm2 logs metasheet-windows-gateway
.\windows-native-stop.bat
```

## 9. Explicit non-authorization

This document and any package built from it are Draft/HOLD preparation assets.
They are not:

- deployment authorization
- staging authorization
- customer UAT acceptance
- release approval
- permission to enable rollout flags
- permission to send external notifications
- grounds to close umbrella issues
