# smoke:sqlserver — expose the B3 legacy-TLS lever via env — development verification (2026-05-30)

> Small data-sources Lane-B follow-up: lets an operator drive the **B3 legacy-TLS lever**
> (`MSSQLAdapter.buildLegacyTlsOptions`, merged #1997) from `pnpm --filter @metasheet/core-backend
> smoke:sqlserver` **via env**, so a real legacy SQL Server (2008R2/2012) can be validated without
> editing the script. On the **generic data-sources `MSSQLAdapter`** — does **not** touch the
> integration-core `k3-wise-sqlserver-*` channel (K3 red line).

## What shipped

- `packages/core-backend/scripts/smoke-sqlserver.ts`:
  - `buildConfig()` now reads the three B3 knobs and maps them straight onto the connection (the exact
    seam the adapter consumes): `MSSQL_LEGACY_TLS` → `connection.legacyTls`, `MSSQL_TLS_MIN_VERSION` →
    `connection.tlsMinVersion`, `MSSQL_TLS_CIPHERS` → `connection.tlsCiphers` (new `optionalString`
    helper; empty/whitespace → unset, no silent default).
  - `buildConfig` is now **exported** (for the test); the script body is guarded by an **entry check**
    (`import.meta.url === argv[1]`) so importing it never triggers a connection attempt — verified the
    direct run still skips cleanly with no `MSSQL_HOST`.
  - `--help` + the `[sqlserver-smoke] target` log now surface `legacyTls`/`tlsMinVersion`/`tlsCiphers`
    so the downgrade is visible in the evidence (values-free — TLS knobs, not secrets).
- `packages/core-backend/scripts/smoke-sqlserver.test.ts` (new) — verification.
- `docs/development/sqlserver-smoke-runbook-20260528.md` — adds the Legacy-TLS lever env block + the
  `encrypt=false` mutual-exclusion note.

## The seam (why this is enough)

The preview-to-resolve chain is: **env → `connection.{legacyTls,tlsMinVersion,tlsCiphers}`** (this slice)
→ **`MSSQLAdapter.buildLegacyTlsOptions` → `cryptoCredentialsDetails.{minVersion,ciphers}`** (already
covered by the adapter's own 26 unit tests, #1997). This slice tests the **first hop** (the env actually
reaches the connection config); the adapter owns the rest. The adapter also enforces `encrypt=false` +
any B3 key → throw, which the smoke surfaces loudly.

## Tests + negative control

`scripts/smoke-sqlserver.test.ts` (4 passed; runs under CI's `vitest` — `*.test.ts` is included, not
excluded): TLS env → connection mapping · unset env → keys absent (no silent defaults) · whitespace →
unset (never an empty cipher string) · non-boolean `MSSQL_LEGACY_TLS` → throws (no silent coercion).
**Negative control**: removing the three `putOptional` env reads → the mapping test fails (the exposure
is load-bearing, not a no-op). The import-safe entry guard verified by a direct `tsx` run skipping
cleanly (exit 0).

## Out of scope

- The real-legacy run itself (needs a 2008R2/2012 SQL Server — Lane B4, no hardware here).
- B0 shared-mssql-helper refactor (deprioritized); A6 Postgres unit test (next).
