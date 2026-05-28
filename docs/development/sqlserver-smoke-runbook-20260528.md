# SQL Server Data Source Smoke Runbook

Date: 2026-05-28

This runbook validates the generic `type=sqlserver` data source path that landed in Lane B PR1. It is intentionally a real-connection smoke check, not a unit test replacement.

## What This Proves

- The backend runtime can load the `mssql` driver.
- The target SQL Server accepts TCP connections from the backend host.
- The default TLS posture works: `encrypt=true` and `trustServerCertificate=true`.
- Basic read operations work through `MSSQLAdapter`: connect, `SELECT 1`, parameterized query, schema introspection, table info, and sample select.

## Prerequisites

- SQL Server TCP/IP is enabled.
- The backend host can reach the SQL Server port, normally `1433`.
- A SQL username/password exists. Windows Integrated Auth / SSPI / Kerberos is outside this smoke path.
- Use a read-only database account for customer or production-like databases.

## Environment

Required:

```bash
export MSSQL_HOST='192.168.1.20'
export MSSQL_PORT='1433'
export MSSQL_DATABASE='ERP'
export MSSQL_USERNAME='readonly_user'
export MSSQL_PASSWORD='...'
```

Optional:

```bash
export MSSQL_SCHEMA='dbo'
export MSSQL_TABLE='SomeReadOnlyTable'
export MSSQL_ENCRYPT='true'
export MSSQL_TRUST_SERVER_CERTIFICATE='true'
export MSSQL_CONNECTION_TIMEOUT_MS='10000'
export MSSQL_REQUEST_TIMEOUT_MS='30000'
```

Compatibility alias:

```bash
export MSSQL_SERVER='192.168.1.20,1433'
```

Use either `MSSQL_HOST` plus `MSSQL_PORT`, or `MSSQL_SERVER`. If both are supplied, `MSSQL_HOST` wins. If `MSSQL_SERVER` embeds a port and `MSSQL_PORT` is also supplied, the two ports must agree.

## Run

```bash
pnpm --filter @metasheet/core-backend smoke:sqlserver
```

For very large customer databases, schema introspection may be noisy because it walks table metadata. Use this narrower smoke when needed:

```bash
export MSSQL_SKIP_SCHEMA='true'
pnpm --filter @metasheet/core-backend smoke:sqlserver
```

## Expected Output

The successful path prints:

```text
[ok] connected
[ok] testConnection SELECT 1
[ok] parameterized query
[ok] schema introspection
```

If `MSSQL_TABLE` is set, it should also print:

```text
[ok] table exists
[ok] table info
[ok] select sample
```

## Local SQL Server Option

Microsoft SQL Server itself is not open source. For local testing, use SQL Server Developer or Express, or the official SQL Server container image. The container requires accepting Microsoft's EULA and is commonly amd64-oriented; on Apple Silicon, Docker Desktop may need amd64 emulation.

Do not run the container against customer data. For customer verification, prefer the real Windows SQL Server host with a read-only SQL login.

## Pass Criteria

- All required `[ok]` lines appear.
- No password or token is printed.
- `MSSQL_ENCRYPT=true` works with the target server, or any `MSSQL_ENCRYPT=false` fallback is explicitly recorded as a legacy compatibility exception.
- If a real table is supplied, `select sample` returns without write permissions.

## Failure Triage

- `mssql package is not installed`: run `pnpm install` from the repo root and verify `pnpm-lock.yaml` includes `mssql`.
- Login failure: verify SQL authentication is enabled and the account is not a Windows-only login.
- Timeout or refused connection: verify SQL Server TCP/IP, firewall, port, VPN, and backend host routing.
- TLS/pre-login failure: first try the default `encrypt=true` and `trustServerCertificate=true`; use `MSSQL_ENCRYPT=false` only as an explicit legacy escape hatch.
