# SQL Server real-wire smoke gate — verification (B5A)

Date: 2026-05-29 · Track: data-sources Lane B · Slice: **B5A** (real-wire smoke gate)

Companion to the run instructions in `sqlserver-smoke-runbook-20260528.md` (#1989). This slice makes
the smoke an **opt-in gate** (CI-safe) and strengthens its coverage, so the generic `type=sqlserver`
adapter (`MSSQLAdapter`, #1985) can be **proven against a real SQL Server**, not only the fake-driver
unit tests. It does **not** touch the K3 `k3-wise-sqlserver` channel, Windows-native deploy, or add
any new connector.

## Why this slice
Before B5A the `MSSQLAdapter` had been exercised **only against a structural fake driver** (unit tests
in `mssql-adapter.test.ts`). There was **no evidence** that its generated SQL — `[bracket]` quoting,
`TOP` / `OFFSET…FETCH`, `$N`→`@pN` parameter translation, `INFORMATION_SCHEMA`/`sys.*` introspection —
actually executes against a real SQL Server engine. That is the classic wire-vs-fixture gap. B5A closes
it with a real-connection smoke, gated so it never runs (and never falsely "passes") in normal CI.

## Gate behavior (CI-safe, opt-in)
`pnpm --filter @metasheet/core-backend smoke:sqlserver` now:
- **Skips cleanly (exit 0)** when no target is configured (`MSSQL_HOST` and `MSSQL_SERVER` both unset).
  Safe to invoke anywhere — normal CI has no SQL Server, so it is a no-op there, **not a failure and not
  a silent green over a broken path**.
- **Runs for real** when a target is configured. A configured-but-incomplete env (e.g. host set, password
  missing) still fails loudly — that is a misconfiguration, not a skip.

This avoids the "skip-when-unreachable" trap two ways: the skip is explicit and logged, and the real run
is the only thing that can print the `[ok]` lines.

## Coverage (read-only; matches the A-RO posture)
The smoke drives `MSSQLAdapter` end-to-end against the target:
1. `connect()` — loads the `mssql` driver, TCP + TLS handshake (default `encrypt=true`, `trustServerCertificate=true`).
2. `testConnection()` — `SELECT 1`.
3. parameterized query — `SELECT $1` → exercises the `$N`→`@pN` translation.
4. `getSchema(schema)` — `INFORMATION_SCHEMA` + `sys.*` introspection (skippable via `MSSQL_SKIP_SCHEMA`).
5. (with `MSSQL_TABLE`) `tableExists` + `getTableInfo` (columns + PK), and — **only on the default `dbo`
   schema** — `select` **TOP** (`{limit}`) + `select` **OFFSET/FETCH** (`{limit, offset, orderBy}`), both
   pagination branches. `adapter.select()` emits `FROM [table]` (unqualified → resolves against the login
   default schema), so on a non-`dbo` `MSSQL_SCHEMA` the select probes are **skipped** (`[skip] select
   probes …`) while the schema-qualified `tableExists`/`getTableInfo` still run. (Making `select()`
   schema-aware is a separate adapter enhancement, not B5A.)

No write path is exercised (the source is read-only by default; write-enable is a separate gate).

## Run against a real SQL Server

### Automated — CI matrix (B4; recommended, no local docker needed)
`.github/workflows/sqlserver-smoke.yml` runs this smoke against **real SQL Server 2019 + 2022 service
containers** whenever the data-source adapter / smoke changes (path-filtered, plus `workflow_dispatch`).
It seeds `smoke_db.dbo.smoke_probe`, then runs the full smoke (connect / `SELECT 1` / `$N`→`@pN` /
introspection / tableInfo / TOP + OFFSET-FETCH). The **green `SQL Server <ver> real-wire smoke` job
runs are the evidence** — `amd64` runners run the image natively, so no local docker is required.

### Manual (local) — 2019/2022 container (Linux, free official image)
```bash
# 2022 (or mcr.microsoft.com/mssql/server:2019-latest)
docker run -d --name mssql-smoke -e 'ACCEPT_EULA=Y' -e 'MSSQL_SA_PASSWORD=Str0ng!Passw0rd' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
# wait for startup, then:
export MSSQL_HOST=127.0.0.1 MSSQL_PORT=1433 MSSQL_DATABASE=master \
       MSSQL_USERNAME=sa MSSQL_PASSWORD='Str0ng!Passw0rd' MSSQL_ENCRYPT=true MSSQL_TRUST_SERVER_CERTIFICATE=true
pnpm --filter @metasheet/core-backend smoke:sqlserver
# optionally point MSSQL_TABLE at a real table to exercise tableInfo + both select branches
docker rm -f mssql-smoke
```
(On Apple Silicon the image is amd64 → Docker Desktop emulation; on an amd64 Linux host it runs natively.)

### Option B — customer / real Windows SQL Server
Use a **read-only** SQL login; never the container against customer data. See the runbook for prerequisites
(TCP/IP enabled, port reachable) and failure triage.

## Pass criteria
- With no env: `[skip] … Exiting 0.` and exit code 0.
- With a target: all applicable `[ok]` lines print; no password/token printed; `select` returns without
  write permission; if `MSSQL_ENCRYPT=false` was needed it is recorded as an explicit legacy exception.

## Evidence

| Check | Status | Evidence |
|---|---|---|
| Gate skips cleanly without env (CI-safe) | ✅ **PASS (2026-05-29)** | `[skip] SQL Server smoke skipped — no MSSQL_HOST / MSSQL_SERVER set … Exiting 0.` · **exit code 0** (run on the authoring host with all `MSSQL_*` unset) |
| `tsc --noEmit` (core-backend) | ✅ PASS | clean |
| fake-driver unit suite (`mssql-adapter.test.ts`) | ✅ PASS (pre-existing, #1985/#1997) | green |
| **Real-wire run, SQL Server 2019 + 2022** | ✅ **via CI matrix (B4), green-gated** | `.github/workflows/sqlserver-smoke.yml` seeds + runs the full smoke against 2019 + 2022 service containers; the `SQL Server 2019/2022 real-wire smoke` checks **gate this PR** (and run on `main`) — green = the adapter's connect + SQL codegen proven on both versions. Supersedes the earlier "no local docker" gap. |
| Real-wire run, SQL Server 2008R2 / 2012 | ⏳ Windows-VM follow-up | No Linux container image (Windows-only binaries) → out of the B4 Linux-container scope; protocol-mock / a future Windows-VM run covers these. |

## Scope / non-goals
- Read-only smoke; no write path, no schema mutation.
- Does **not** touch `plugin-integration-core`'s `k3-wise-sqlserver` channel, RBAC, or auth.
- Not Windows-native deploy (Lane C) and not a new connector.
- Next: **B4** (full 2017/2019/2022 version-compat matrix on this harness; 2008R2/2012 → Windows VM follow-up).
