# S6-A synthetic end-to-end lab in CI — feasibility (2026-08-18)

Scope: can #4708's *functional* evidence be produced in GitHub Actions instead of on the LAB-0
machine? Synthetic data only. Nothing here re-freezes a package, arms a flag default, deploys, or
touches #4695's frozen inputs or a customer source.

## Verdict

**All 8 items are producible in CI; 6 already run today; the other 2 need small, mechanical
deltas.** #4708 is not blocked on a physical machine for its *functional* claims — it is blocked on a
machine only for *Windows-host installation* claims, which are a different and much smaller question.
The caveat on item 1: CI proves install-and-run on a Linux runner, not on a Windows host.

The decisive fact: `.github/workflows/stock-preparation-e2e-functional-smoke.yml` already stands up
ephemeral `postgres:16` + `mcr.microsoft.com/mssql/server:2022-latest`, seeds a synthetic
`nvarchar(max)` relation, turns `ALLOW_SNAPSHOT_ISOLATION ON`, creates a dedicated SQL login with only
`GRANT SELECT ON OBJECT::`, provisions two separated non-superuser PostgreSQL roles, applies migrations
with both role GUCs visible, sets `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED=true` **only
in its own spawned server process**, walks capture → private ingestion → generation kernel → apply →
activation, replays the same `operationId`, and asserts `mode=internal_noop`, `replay=true`,
`sourceReadCount=1`, `externalWrite=false`, plus a byte-identical database write-state snapshot.
Dispatched runs complete in **~2.5–3.5 minutes**.

## Per-item mapping

| # | #4708 evidence item | Status in CI | Where |
|---|---|---|---|
| 1 | Package install in isolated runtime | **Partial** — package is built, five-check-verified, deps installed with `--frozen-lockfile`, migrations run from `dist/src/db/migrate.js`; but the S6-A walk runs from the **repo tree**, not the installed package | `stock-prep-main-package-verify.yml`, `stock-prep-s6a-postgres17-validation.yml` |
| 2 | SQL Server 2022 Developer + snapshot isolation | **Proven** (edition not yet asserted) | e2e smoke `prepareSqlServerRelation()`; `waitForSnapshotIsolationOn()` polls `snapshot_isolation_state=1` |
| 3 | Nonprivileged read-only source identity | **Proven** — `CREATE LOGIN` + `CREATE USER` + object-level `GRANT SELECT`; product re-proves `IS_SRVROLEMEMBER('sysadmin')`/`db_owner`/`db_datawriter` = 0 and no INSERT/UPDATE/DELETE/ALTER/CONTROL | `sqlserver-sealed-snapshot-source-session.cjs:19-28` |
| 4 | Migration 073 + separated roles | **Proven**, and beyond: 073 on PG **15/16/17**; 074/075 gates on 16/17; separated roles created NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/NOINHERIT, neither a member of the other | `stock-preparation-e2e-provision-postgres-roles-and-migrate.mjs`; `sealed-export-s6a-grant-repair.yml`, `sealed-export-s6a-authority-row-lock.yml` |
| 5 | One run, 1..24,999 lines | **Reachable in one dispatch** — `s6a_row_count` input drives a mid-tier walk at any N plus a rejection arm at 24,999+1 (refused end to end). Default 3 | e2e smoke `scale-midtier` / `scale-rejection` jobs |
| 6 | Replay `sourceReadCount=1` + `internal_noop` | **Proven**, with a live-snapshot positive control so "unchanged" cannot pass vacuously | e2e smoke lines ~1793-1840 |
| 7 | `externalWrite=false` | **Proven** at provisioning, first run, and replay | e2e smoke |
| 8 | Unconditional flag-OFF restoration + cleanup | **Gap** — flag-OFF/exact-match arms run **before** the ON window; nothing re-proves OFF after it, and there is no retention/purge evidence | — |

## Gap list (all CI-closable)

1. **Package-mode walk.** `startServer()` hardcodes `spawn('pnpm', ['--filter','@metasheet/core-backend','run','dev:core'], { cwd: REPO_ROOT })`. Needs an `E2E_SERVER_ROOT` / `E2E_SERVER_CMD` override so the same harness can drive the extracted package root. Small, mechanical.
2. **Post-ON flag-OFF restoration arm** — restart flag-OFF, re-assert health capability `false`, sibling route 200, S6-A route 404, and assert no committed file / repo var carries the flag.
3. **Source-identity + edition evidence emitter** — `SERVERPROPERTY('Edition'|'ProductMajorVersion')` and the reader principal's permission matrix, as values-free lines rather than only an internal product check.
4. **Cleanup/retention evidence** — artifact-root capture directory removed, run/generation counts, containers destroyed with the job.
5. **Scale default.** The 24,999 walk is opt-in; the lab lane should default to it.

## PostgreSQL matrix

Today: e2e smoke and the S5 gate use **16 only**; `stock-prep-s6a-postgres17-validation.yml` and
`stock-prep-main-package-verify.yml` use **15/16/17**; 074/075 gates use **16/17**. Proposal: run the
lab walk on **15, 16, 17** (`fail-fast: false`). That directly answers #4695's "PostgreSQL 17 while the
packet is validated only on 15/16" blocker with *functional* evidence, not just migration-apply
evidence. Cost is 3 parallel jobs, not 3× wall clock.

## SQL Server image

Keep `mcr.microsoft.com/mssql/server:2022-latest` (matrix-extensible to `2019-latest`, as S2/S5
already do). With `MSSQL_PID` unset the container defaults to **Developer**, matching #4708 item 2 —
but the lane must *assert* the edition rather than assume it. Note the trap recorded in #4695:
`engineMajorVersionFromProductMajor` maps only 15→2019 and 16→2022; every other major yields `null`
and fails only inside the flag-on window. A CI matrix is the cheapest place to pin that.

## Estimated runtime

Build + verify package ≈ 4 min (measured, `stock-prep-main-package-verify.yml`). Each lab walk leg
≈ 3–6 min at 3 rows; the 24,999-row leg adds fixture seeding — the rejection arm already seeded and
refused 25,000 rows in ~2.6 s, so seeding is not the cost driver. **Whole lane ≈ 12–20 minutes wall
clock** with legs in parallel.

## What remains machine-only

Only Windows-host claims: the Microsoft-signed SQL Server 2022 Developer **installer** path (the exact
thing that failed three times as `LAB_ROOT_ACL_FAILED` / `SQLSERVER_INSTALL_INTERNAL_ERROR`), PM2
process management, the PowerShell 5.1 operator acceptance in a real elevated session, on-host ACLs,
port 8900, and reboot behaviour. Note `plugin-tests.yml`'s `stock-prep-powershell51` job already runs
`stock-preparation-s6a-onprem-acceptance.ps51.tests.ps1` under real `powershell.exe` on
`windows-latest` — the PS 5.1 *contract* is CI-covered; only the *installer* is not.

## Feeding a package re-freeze

#4695's 2026-08-04 disclosure names three failure points in the frozen package: missing 074, the
`projectExternalSystem` projection defect, and missing 075. A green lab run on a package **built from
the candidate commit in the same run** demonstrates all three are cleared, on 15/16/17, at the declared
bound — before any owner spends `authorizedRunCount=1`. The lane emits `serviceRuntimeSha`,
`packageTgzSha256`/`packageZipSha256`, and per-item PASS lines that map 1:1 onto #4708's list, which is
exactly the shape a re-freeze proposal needs. It does **not** publish a release and establishes no
real-customer, external-write, or rollout claim.
