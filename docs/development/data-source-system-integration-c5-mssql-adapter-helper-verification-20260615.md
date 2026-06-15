# Data Source System Integration C5-2 Verification - Generic MSSQL Adapter Helper Wire

Date: 2026-06-15
Scope: C5-2 generic `MSSQLAdapter` minimal production wire to `@metasheet/mssql-readonly-utils`

## Summary

This slice wires the generic SQL Server data-source adapter to the shared helper package introduced in C5-1.

Migrated to helper:

- SQL Server endpoint parsing (`host` / `server` + optional port);
- legacy TLS option normalization;
- MSSQL identifier quoting.

Kept local for later gated slices:

- `WhereClause` generation stays in `BaseAdapter`; moving it would affect shared Postgres/MySQL/MSSQL semantics and is not part of C5-2;
- INFORMATION_SCHEMA schema introspection stays in `MSSQLAdapter`; C5-4 owns schema/read-only smoke alignment;
- K3 SQL Server executor stays unchanged until C5-3.

## Guardrails Verified

- Existing MSSQL config mapping and legacy-TLS tests still pass.
- Existing MSSQL SQL-generation tests still pass.
- Existing identifier-quoting tests still pass.
- Compatibility hardening covers instance-style server ports (`db\inst,1444`), SQL Server identifiers with numeric
  leading segments / more than two dot-separated segments, and the old boolean/string-only coercion for
  security-sensitive TLS/encryption knobs.
- Existing result-boundary tests still pass.
- Core-backend now depends on `@metasheet/mssql-readonly-utils` at runtime, because production adapter code imports it.
- No K3 SQL Server executor behavior changed.
- No write-path behavior changed.

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/mssql-adapter.test.ts \
  tests/unit/data-source-identifier-quoting.test.ts \
  tests/unit/data-source-result-boundary.test.ts \
  tests/unit/mssql-readonly-utils-consumer.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/mssql-readonly-utils test
git diff --check
```

## Boundaries

- No K3 executor migration.
- No K3 Submit/Audit/BOM behavior opened.
- No generic DB write behavior opened.
- No route/UI/package release change.
- No external DB write change.
