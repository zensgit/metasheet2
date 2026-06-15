# Data Source System Integration C5-4a Verification - K3 MSSQL Smoke Harness

Date: 2026-06-15
Scope: C5-4a TLS alignment and values-free K3 SQL Server smoke harness

## Summary

This slice prepares the C5-4 entity-machine validation without claiming the entity-machine gate has passed.

Runtime changes:

- K3 default SQL Server executor now accepts the same opt-in legacy TLS knob names used by generic MSSQL:
  `legacyTls`, `tlsMinVersion`, and `tlsCiphers`.
- The K3 default TLS posture remains unchanged when those knobs are absent.
- When legacy TLS knobs are present, the executor keeps the wire encrypted and attaches
  `options.cryptoCredentialsDetails`; `encrypt=false` combined with legacy TLS fails closed.

Smoke harness:

- Adds `pnpm --filter plugin-integration-core smoke:k3-sqlserver-executor`.
- The smoke builds a configured `erp:k3-wise-sqlserver` channel over the built-in executor, then runs
  `testConnection` and one bounded read against an operator-approved table.
- The harness prints only values-free evidence: statuses, configured table name, column count, row count, TLS knob names
  / booleans, and no credentials, connection strings, raw SQL, row values, or K3 payloads.
- Failure output is values-free by default: runtime/driver failures print code/name only; config validation errors print
  the missing/invalid env key without secret values.

## Guardrails Verified

- Existing K3 channel and executor tests still pass.
- New tests pin:
  - K3 SQL Server default `encrypt=false` remains unchanged with no legacy TLS knobs;
  - explicit `legacyTls=true` adds the documented TLSv1 / `DEFAULT@SECLEVEL=0` credentials details and keeps
    `encrypt=true`;
  - explicit TLS min-version/ciphers override the convenience defaults;
  - `legacyTls=true` plus `encrypt=false` throws `SQLSERVER_TLS_CONFLICT`;
  - the smoke script skips cleanly when not configured;
  - the smoke script uses the K3 channel and redacts evidence by construction.
  - the smoke script's public error formatter does not echo raw driver messages that might carry connection details.

## Verification Commands

```bash
pnpm --filter plugin-integration-core test:k3-wise-adapters
pnpm --filter plugin-integration-core test:k3-sqlserver-smoke
pnpm --filter plugin-integration-core test:mssql-readonly-utils
pnpm --filter @metasheet/mssql-readonly-utils test
pnpm --filter plugin-integration-core test
git diff --check
```

## Boundaries

- No entity-machine smoke is claimed in this slice.
- No K3 Save / Submit / Audit / BOM behavior opened.
- No generic DB write behavior opened.
- No `DataSourceManager` or generic `MSSQLAdapter` dependency added to the K3 plugin path.
- No credentials, connection strings, raw SQL, row values, or K3 payloads added to docs or smoke output.

## Remaining Gate

C5-4b remains open: deploy a package from this slice or newer to the approved entity-machine environment, run the generic
SQL Server smoke plus the K3 SQL Server smoke, and post values-free evidence.
