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

Legacy-TLS lever (B3) — to validate against a **legacy** SQL Server (2008R2/2012) WITHOUT upgrading it.
The downgrade keeps the wire **encrypted**; do NOT combine it with `MSSQL_ENCRYPT='false'` (the adapter
throws — plaintext is a separate, mutually-exclusive hatch):

```bash
export MSSQL_LEGACY_TLS='true'              # convenience: applies TLSv1 + DEFAULT@SECLEVEL=0 defaults
# …or set the floor / ciphers explicitly (these win over the legacyTls defaults):
export MSSQL_TLS_MIN_VERSION='TLSv1'        # enum-strict; a bad value fails loudly
export MSSQL_TLS_CIPHERS='DEFAULT@SECLEVEL=0'
```

The smoke logs the active `legacyTls` / `tlsMinVersion` / `tlsCiphers` in its `[sqlserver-smoke] target`
line so the downgrade is visible in the evidence (values-free — these are TLS knobs, not secrets).

Compatibility alias:

```bash
export MSSQL_SERVER='192.168.1.20,1433'
```

Use either `MSSQL_HOST` plus `MSSQL_PORT`, or `MSSQL_SERVER`. If both are supplied, `MSSQL_HOST` wins. If `MSSQL_SERVER` embeds a port and `MSSQL_PORT` is also supplied, the two ports must agree.

## Run

> Opt-in gate (B5A): with no `MSSQL_HOST`/`MSSQL_SERVER` set, this command **skips (exit 0)** and is
> therefore CI-safe; configure a target (above) to run it for real. The gate behavior, strengthened
> coverage (incl. the OFFSET/FETCH branch), and a 2019/2022 container recipe are in
> `sqlserver-smoke-wire-gate-verification-20260529.md`.

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
[ok] select sample (TOP)
[ok] select page (OFFSET/FETCH)
[ok] select schema-qualified ([schema].[table])
```

The two `select` lines cover both pagination branches (`TOP` and `OFFSET…FETCH`). They run only when
`MSSQL_SCHEMA` is the default `dbo`: `adapter.select()` is not schema-qualified, so on a non-`dbo`
schema you instead see `[skip] select probes …` and only the schema-qualified metadata checks
(`table exists` / `table info`) run.

## Local SQL Server Option

Microsoft SQL Server itself is not open source. For local testing, use SQL Server Developer or Express, or the official SQL Server container image. The container requires accepting Microsoft's EULA and is commonly amd64-oriented; on Apple Silicon, Docker Desktop may need amd64 emulation.

Do not run the container against customer data. For customer verification, prefer the real Windows SQL Server host with a read-only SQL login.

## Pass Criteria

- All required `[ok]` lines appear.
- No password or token is printed.
- `MSSQL_ENCRYPT=true` works with the target server, or any `MSSQL_ENCRYPT=false` fallback is explicitly recorded as a legacy compatibility exception.
- If a real table is supplied on the default `dbo` schema, both `select sample (TOP)` and `select page (OFFSET/FETCH)` return without write permissions. On a non-`dbo` schema the select probes are skipped (`adapter.select()` is not schema-qualified); the schema-qualified metadata checks still run.

## Failure Triage

- `mssql package is not installed`: run `pnpm install` from the repo root and verify `pnpm-lock.yaml` includes `mssql`.
- Login failure: verify SQL authentication is enabled and the account is not a Windows-only login.
- Timeout or refused connection: verify SQL Server TCP/IP, firewall, port, VPN, and backend host routing.
- TLS/pre-login failure: first try the default `encrypt=true` and `trustServerCertificate=true`; use `MSSQL_ENCRYPT=false` only as an explicit legacy escape hatch.
