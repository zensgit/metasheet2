# Readonly Bridge Agent Runbook - BA-M1 MVP

Date: 2026-05-21

## Purpose

This runbook starts the BA-M1 standalone readonly Bridge Agent on the selected
MetaSheet on-prem Windows server. The first implementation is intentionally a
PowerShell 5.1 script hosted on .NET Framework `System.Data.SqlClient`, not a
Windows service yet.

The goal is to prove the Bridge Agent HTTP/JSON protocol and readonly SQL
allowlist on the customer bridge host before integrating it into the MetaSheet
backend or Data Factory UI.

## Scope

In scope:

- same-machine deployment on the MetaSheet on-prem Windows server;
- bind to `127.0.0.1`;
- `System.Data.SqlClient`;
- `GET /health`;
- `GET /objects`;
- `GET /schema/<object>`;
- `POST /query/<object>`;
- allowlisted `material`, `bom`, `bom_child` examples;
- hard row limits;
- redacted errors.

Out of scope:

- Windows Service packaging;
- MetaSheet `plugin-integration-core` integration;
- Data Factory UI wiring;
- raw SQL endpoint;
- SQL writes;
- K3 Save / Submit / Audit;
- non-localhost deployment.

## Files

- Agent script: `scripts/ops/bridge-agent-readonly.ps1`
- Example config:
  `scripts/ops/fixtures/bridge-agent-readonly/config.example.json`

Real config must stay outside Git, for example:

```text
C:\ProgramData\MetaSheet\BridgeAgent\config.json
```

## Local Secret Setup

Use environment variables owned by the local bridge process account. Do not put
these values into Git, issue comments, PR bodies, screenshots, or evidence
artifacts.

```powershell
$env:METASHEET_BRIDGE_SQL_USERNAME = '<readonly-sql-login>'
$env:METASHEET_BRIDGE_SQL_PASSWORD = '<readonly-sql-password>'
$env:METASHEET_BRIDGE_SHARED_SECRET = '<local-shared-secret>'
```

For a persistent operator setup, store them using the chosen Windows secret
mechanism and inject them into the process environment before start. BA-M1 MVP
does not prescribe the final service secret store.

## Config Setup

Copy the example config to the private host path:

```powershell
New-Item -ItemType Directory -Force 'C:\ProgramData\MetaSheet\BridgeAgent' | Out-Null
Copy-Item `
  'C:\metasheet\scripts\ops\fixtures\bridge-agent-readonly\config.example.json' `
  'C:\ProgramData\MetaSheet\BridgeAgent\config.json'
```

Edit only local placeholders:

- `database.server`
- `database.database`
- optional object `source` values if the customer provides readonly views
  instead of direct tables.

Preferred readonly views:

```text
v_MetaSheet_MaterialRead
v_MetaSheet_BomRead
v_MetaSheet_BomChildRead
```

## Validate Config

```powershell
powershell -ExecutionPolicy Bypass -File C:\metasheet\scripts\ops\bridge-agent-readonly.ps1 `
  -ConfigPath C:\ProgramData\MetaSheet\BridgeAgent\config.json `
  -ValidateConfigOnly
```

Expected:

```text
[bridge-agent-readonly] config validation passed
```

## Start Agent

```powershell
powershell -ExecutionPolicy Bypass -File C:\metasheet\scripts\ops\bridge-agent-readonly.ps1 `
  -ConfigPath C:\ProgramData\MetaSheet\BridgeAgent\config.json
```

Expected:

```text
[bridge-agent-readonly] starting http://127.0.0.1:19091/
```

If `HttpListener` requires URL ACL setup in the customer Windows environment,
run the equivalent command as Administrator:

```powershell
netsh http add urlacl url=http://127.0.0.1:19091/ user=<service-account>
```

## Smoke Commands

All commands run on the MetaSheet on-prem server.

```powershell
$headers = @{ 'X-MetaSheet-Bridge-Secret' = $env:METASHEET_BRIDGE_SHARED_SECRET }

Invoke-RestMethod `
  -Headers $headers `
  -Uri 'http://127.0.0.1:19091/health'

Invoke-RestMethod `
  -Headers $headers `
  -Uri 'http://127.0.0.1:19091/objects'

Invoke-RestMethod `
  -Headers $headers `
  -Uri 'http://127.0.0.1:19091/schema/material'

Invoke-RestMethod `
  -Headers $headers `
  -Method Post `
  -Uri 'http://127.0.0.1:19091/query/material' `
  -ContentType 'application/json' `
  -Body '{"limit":3}'
```

Expected:

- `/health`: `ok=true`; `databaseReachable=true`.
- `/objects`: only allowlisted objects appear.
- `/schema/material`: only configured fields appear.
- `/query/material`: at most 3 rows, selected only from configured fields.

## Negative Checks

Unknown object must fail:

```powershell
Invoke-RestMethod `
  -Headers $headers `
  -Uri 'http://127.0.0.1:19091/schema/not_allowlisted'
```

Raw SQL must fail:

```powershell
Invoke-RestMethod `
  -Headers $headers `
  -Method Post `
  -Uri 'http://127.0.0.1:19091/query/material' `
  -ContentType 'application/json' `
  -Body '{"sql":"SELECT * FROM t_ICItem"}'
```

Excessive limit must fail:

```powershell
Invoke-RestMethod `
  -Headers $headers `
  -Method Post `
  -Uri 'http://127.0.0.1:19091/query/material' `
  -ContentType 'application/json' `
  -Body '{"limit":9999}'
```

## Handoff Criteria

BA-M1 MVP is ready for BA-M2 integration work only when:

- config validation passes;
- `/health` confirms database reachability;
- `/objects` shows only allowlisted objects;
- `/schema/material`, `/schema/bom`, `/schema/bom_child` return safe schemas;
- `/query/*` returns capped rows for approved objects;
- unknown objects, raw SQL, and excessive limits are blocked;
- no secret-shaped values appear in logs or copied evidence;
- no SQL writes occurred.
