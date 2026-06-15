# Data Source System Integration C5 - K3 Generic MSSQL Seam Design

Status: design-first / no runtime
Date: 2026-06-15

## Purpose

C5 narrows the gap between two SQL Server paths that now exist in the repo:

- the generic `/data-sources` `type=sqlserver` path, implemented by `MSSQLAdapter`;
- the integration plugin's `erp:k3-wise-sqlserver` channel, implemented by
  `k3-wise-sqlserver-channel.cjs` plus the default read-only executor.

The goal is reuse of stable, low-level MSSQL read-only mechanics: connection option parsing, per-source
TLS posture, identifier quoting, structured SELECT construction, and schema/introspection smoke coverage.
It is not a product decision to merge K3 into generic data-source execution, and it is not a shortcut to
any K3 write surface.

## Grounding In Current Code

Generic MSSQL currently lives in `packages/core-backend/src/data-adapters/MSSQLAdapter.ts`:

- it attempts the optional `mssql` require at module load, then reports a clear connect-time error if the
  package is unavailable;
- `resolveServerAndPort()` supports `host`, `server`, and embedded port forms;
- `buildLegacyTlsOptions()` is per-source, enum-strict, rejects `encrypt=false` combined with legacy TLS,
  emits a downgrade signal, and keeps the wire encrypted;
- `select()` builds bounded structured SELECTs through the common `QueryOptions` contract;
- `getSchema()` / `getTableInfo()` / `getColumns()` use `INFORMATION_SCHEMA` and `sys.*` metadata queries;
- the adapter class also has `insert()`, `update()`, `delete()`, transactions, and generic `query()`, so
  the whole adapter/manager surface is not safe to hand to the K3 channel.

K3 SQL Server currently lives in `plugins/plugin-integration-core`:

- `k3-wise-sqlserver-channel.cjs` is the K3 adapter boundary. It owns K3 object manifests, table allowlists,
  read/write operation checks, and the default middle-table write guard. Current code also has an explicit
  backend-only `allowDirectTableWrite` object-config exception; C5 must not expand or route through that exception.
- `k3-wise-sqlserver-executor.cjs` is the built-in deployment-safe executor. It lazy-loads `mssql`, builds
  structured SELECT only, parameterizes simple filter/watermark values, and its `insertMany()` always throws
  `SQLSERVER_WRITE_EXECUTOR_DISABLED`.
- `index.cjs` registers `erp:k3-wise-sqlserver` with that default read-only executor.
- adapter metadata marks `erp:k3-wise-sqlserver` as advanced, with table allowlists and middle-table write
  guardrails.

This means the safe convergence seam is a small read-only MSSQL helper contract. It is not
`DataSourceManager`, not `MSSQLAdapter` as a whole, and not the `data-source:sql-readonly` bridge facade.

## Non-Goals

C5 does not:

- open K3 Submit;
- open K3 Audit;
- open K3 BOM write;
- let generic DB write bypass the K3 adapter contract;
- expand, normalize, or newly depend on K3's existing backend-only `allowDirectTableWrite` escape hatch;
- convert `erp:k3-wise-sqlserver` into `data-source:sql-readonly`;
- copy credentials between `/data-sources` and `integration_external_systems`;
- auto-discover K3 business objects from arbitrary SQL metadata;
- introduce raw SQL input, stored procedures, CTEs, or user-provided SQL.

## Reuse Matrix

| Area | Reuse? | Contract |
| --- | --- | --- |
| `mssql` driver loading/error shape | yes | A helper may centralize missing-driver errors, but must preserve each consumer's load timing unless a compatibility slice changes it. |
| server/port parsing | yes | Preserve generic `host`-wins semantics; K3 must not silently change existing deployed config. |
| timeout parsing | yes, with consumer policy | Generic MSSQL currently allows explicit `0` as no-timeout; K3 currently requires positive integers. The helper must take a policy and test both. |
| TLS option builder | yes, guarded | Reuse enum-strict TLS helpers, but do not silently flip K3's current default. Any default change is a separate compatibility-gated slice. |
| identifier quoting | yes | Per-segment bracket quoting for simple identifiers only. |
| structured SELECT builder | yes, with consumer policy | Generic MSSQL must keep full `WhereClause` support, including `$and`/`$or` and comparison operators for C3 keyset reads. K3 may keep its simpler scalar/array filter contract. Both remain SELECT-only, bounded, and parameterized. |
| `INFORMATION_SCHEMA` metadata | yes, diagnostic only for K3 | Generic can use it for schema UI; K3 may use it for smoke/diagnostics, not to invent K3 business object mappings. |
| generic `DataSourceManager` | no | It exposes broader adapter lifecycle and write-capable adapter methods. |
| `MSSQLAdapter.insert/update/delete/query` | no | These are outside the C5 shared helper. |
| K3 object manifests / allowlists | K3-only | Remain in `k3-wise-sqlserver-channel.cjs`. |
| K3 middle-table/direct-table upsert | K3-only, gated | Built-in executor stays read-only. Middle-table writes and the existing backend-only direct-table exception remain deployment-owned, separately reviewed K3 paths; C5 must not create a generic route to either. |

## Hard Locks

1. Shared helper exports must be read-only by construction.
   - Allowed shapes: connection option normalization, identifier quoting, bounded SELECT builder, metadata query
     builders, result normalization, values-free error normalization.
   - Forbidden exports: `insert`, `update`, `delete`, `upsert`, `transaction`, `rawQuery`, `execute`, or any helper
     that accepts a raw SQL string from a caller.

2. K3 SQL Server keeps its adapter boundary.
   - `erp:k3-wise-sqlserver` remains the adapter kind.
   - `k3-wise-sqlserver-channel.cjs` remains responsible for object allowlists, operation checks, read/write table
     allowlists, the default `middle-table` write guard, and the existing backend-only `allowDirectTableWrite`
     exception.
   - adapter metadata remains advanced/hidden-by-default with the existing K3 SQL guardrails.

3. The built-in K3 executor remains read-only.
   - `insertMany()` continues to throw `SQLSERVER_WRITE_EXECUTOR_DISABLED`.
   - Any future middle-table or direct-table writer remains an explicit deployment-owned executor and its own opt-in.

4. Generic data-source ownership does not become K3 authorization.
   - `/data-sources` owner-scoped reads and `integration_external_systems` K3 systems have different trust models.
   - C5 must not bridge those credential/owner surfaces implicitly.

5. Values-free evidence remains required.
   - C5 tests and smokes can report adapter kind, operation, code, table/object names where already configured,
     counts, and boolean readiness.
   - They must not report credentials, connection strings, raw SQL, row values, K3 payloads, or stack traces with values.

## Implementation Slices

### C5-0 - design lock

This document. No runtime, no route, no UI, no package, no K3 behavior change.

### C5-1 - shared read-only helper contract, latent

Create a runtime-neutral helper consumed through a packaging shape that both core-backend TypeScript and the CJS
plugin can load without reverse-depending on each other. C5-1 must pick one of two acceptable shapes, not leave the
choice implicit:

- a neutral workspace/package module that ships a CJS runtime plus TypeScript declarations; or
- a typed host-injected capability exposed through the plugin context API.

If the injected-capability route is chosen, the capability must be declared on the typed host/plugin API surface, not
only passed as an ad hoc property. In both shapes the implementation PR must prove the chosen shape works in:

- `pnpm --filter @metasheet/core-backend build`;
- `pnpm --filter plugin-integration-core test:k3-wise-adapters`;
- plugin host loader smoke;
- a no-`tsx` CJS/package-runtime smoke or built-`dist` loader smoke, so a plugin `require()` of unbuilt TS cannot pass
  authoring tests and fail in deployment.

Required tests:

- export guard: no write-like export names and no raw-SQL execution export;
- import-boundary guard: `packages/core-backend/**` must not import/require `plugins/plugin-integration-core/**`;
- import-boundary guard: K3 plugin files must not import/require `DataSourceManager` or `MSSQLAdapter` directly;
- neutral-helper guard: if the workspace/package module route is chosen, the helper runtime must not import/require
  `packages/core-backend/src/**` or `plugins/plugin-integration-core/**`; it must stay below both consumers;
- generic SELECT builder preserves `WhereClause` support for `$and`/`$or` groups and comparison operators;
- K3 SELECT builder/policy rejects unsupported operator objects unless a later K3-specific slice explicitly adds them;
- bounded limit behavior is unchanged per consumer: generic omitted limit / over-max behavior remains generic, K3
  omitted limit / clamp behavior remains K3;
- TLS helper keeps per-source scope and rejects contradictory `encrypt=false + legacyTls`;
- timeout policy is per consumer: generic explicit `0` remains allowed, K3 non-positive values remain rejected.

No production call site changes yet.

### C5-2 - generic MSSQL consumes helper without behavior drift

Move the generic `MSSQLAdapter` read-only mechanics onto the helper where safe:

- server/port parsing;
- TLS option building;
- identifier quoting;
- metadata query construction/formatting where practical.

Required tests:

- existing MSSQL adapter tests stay green;
- SQL Server smoke harness still exposes `MSSQL_LEGACY_TLS`, `MSSQL_TLS_MIN_VERSION`, and `MSSQL_TLS_CIPHERS`;
- C3 composite keyset `WhereClause` tests using `$or` / `$gt` remain green;
- explicit timeout `0` still reaches the generic driver config as `0`;
- negative control: removing helper use must fail a helper-parity test, not just leave dead code.

No K3 behavior change in this slice.

### C5-3 - K3 default executor consumes helper for test/select only

Move the built-in K3 SQL Server read-only executor onto the same helper for connection parsing, TLS, quoting, and
structured SELECT. Keep the K3 channel and object contracts in place.

Required tests:

- `insertMany()` still throws `SQLSERVER_WRITE_EXECUTOR_DISABLED`;
- K3 channel upsert still requires operation enablement plus write allowlist;
- K3's default `middle-table` guard remains unchanged, and the existing backend-only `allowDirectTableWrite`
  exception is not expanded, surfaced in UI, or made reachable through the shared helper;
- direct K3 table write remains unsupported unless an explicit K3-owned executor and existing backend-only object
  config opt in;
- K3 TLS default remains unchanged unless a separate compatibility-gated slice changes it;
- K3 limit/timeout behavior remains unchanged;
- K3 read still uses configured objects/allowlists, not arbitrary metadata discovery;
- K3 SQL adapter metadata remains advanced with current guardrails;
- values-free failure messages do not echo credentials or connection strings.
- negative control: breaking the helper path (for example through a fake-helper call trace or a deliberate helper
  mutation in the test) must fail a K3 executor test, proving C5-3 did not leave dead local SQL-building code behind.

### C5-4 - real-wire smoke and runbook update

After C5-2/C5-3, run the generic SQL Server smoke and a K3 SQL Server executor availability smoke against the same
approved entity-machine environment when available.

Evidence must include:

- package fingerprint;
- generic `type=sqlserver` smoke status;
- `erp:k3-wise-sqlserver` test/select smoke status;
- TLS posture knobs used, if any;
- row counts / object names only where already operator-configured;
- no credentials, connection strings, raw SQL, or row values.

## Acceptance Checklist

- [ ] C5-1 helper exists and is read-only by export guard.
- [ ] C5-1 proves plugin CJS and core-backend TS can both consume the helper or host-injected capability.
- [ ] C5-2 generic MSSQL behavior remains byte/shape-compatible with existing tests and smoke harness.
- [ ] C5-3 K3 executor reuses only read-only helper mechanics.
- [ ] `erp:k3-wise-sqlserver` adapter kind, metadata, allowlist model, and K3 write red lines remain unchanged.
- [ ] Existing K3 backend-only direct-table write exception is neither expanded nor exposed by C5.
- [ ] No generic DB write path can reach K3 Submit, Audit, BOM, or core K3 tables.
- [ ] Entity-machine smoke passes before C5 is called closed.

## Relationship To C6

C5 must complete before C6 external write begins. C5 reduces SQL Server plumbing drift; it does not provide a write
permission model, dry-run/apply token, idempotency, rollback, dead-letter, or row-level failure contract. Those remain
C6 design inputs.
