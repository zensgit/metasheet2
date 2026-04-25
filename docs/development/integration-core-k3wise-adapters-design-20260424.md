# Integration Core K3 WISE Adapters Design - 2026-04-24

## Context

M1 already has the external-system registry, adapter contract, pipeline runner,
dead-letter replay, and REST control plane. This slice adds M2 pre-work for the
customer direction "K3 WISE + channel base" without claiming a live customer
environment is connected.

The goal is to make K3 WISE a first-class adapter kind in the runtime registry
so later PoC work can bind real customer endpoints, SQL Server access, field
mappings, and approval rules without changing the runner contract.

## Modules

Added:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`

`index.cjs` now registers three adapter kinds:

```text
erp:k3-wise-sqlserver
erp:k3-wise-webapi
http
```

No K3-specific REST route was added. K3 is invoked through the existing
external-system registry, adapter registry, pipeline runner, dry-run, and
dead-letter replay paths.

## K3 WISE WebAPI Adapter

Adapter kind:

```text
erp:k3-wise-webapi
```

Supported contract methods:

- `testConnection()`
- `listObjects()`
- `getSchema()`
- `upsert()`
- `read()` returns `UnsupportedAdapterOperationError`

The adapter is target-oriented. It posts records to configured K3 WISE WebAPI
`Save` endpoints. `Submit` and `Audit` are explicitly opt-in through
`config.autoSubmit/config.autoAudit` or run options.

Default objects:

- `material`
- `bom`

Default paths:

```text
/K3API/Login
/K3API/Material/Save
/K3API/Material/Submit
/K3API/Material/Audit
/K3API/BOM/Save
/K3API/BOM/Submit
/K3API/BOM/Audit
```

Important safety choices:

- `baseUrl` must be `http` or `https`.
- endpoint paths must be relative to `baseUrl`.
- credentials are read only from the hydrated `system.credentials`; the adapter
  does not read credential storage directly.
- login/session headers are cached inside the adapter instance only.
- one failed record does not abort the whole batch; failures are returned in
  `createUpsertResult().errors` so the runner can write dead letters.
- plaintext credentials are never returned from adapter results.

## K3 WISE SQL Server Channel

Adapter kind:

```text
erp:k3-wise-sqlserver
```

Supported contract methods:

- `testConnection()`
- `listObjects()`
- `getSchema()`
- `read()`
- `upsert()` only for configured middle tables

This module is a channel skeleton. It does not import a SQL Server driver and
does not manage live connections. Runtime code must inject a restricted
`queryExecutor`.

The channel accepts only structured calls:

```js
queryExecutor.select({
  table,
  columns,
  filters,
  watermark,
  limit,
  cursor
})

queryExecutor.insertMany({
  table,
  records,
  keyFields,
  mode
})
```

Important safety choices:

- raw SQL is not accepted.
- table and column identifiers must match a conservative identifier pattern.
- tables must be present in the configured allowlist.
- K3 production tables default to read-only.
- writes are allowed only when the object is configured with
  `writeMode: 'middle-table'`.
- direct writes to tables such as `t_ICItem`, `t_ICBOM`, and `t_ICBomChild` are
  blocked unless a future customer-specific hardening task deliberately changes
  that policy.

Default read objects:

- `material` -> `t_ICItem`
- `bom` -> `t_ICBOM`
- `bom_child` -> `t_ICBomChild`

## Customer GATE Dependency

This slice does not remove the M2 customer GATE. Real K3 WISE hardening still
needs:

- exact K3 WISE version.
- K3API/WebAPI endpoint URLs and auth mode.
- test account set.
- material and BOM field code list.
- whether `Save` should be followed by `Submit/Audit`.
- SQL Server account permission scope.
- whether the customer has a separate integration database or middle tables.

## Deferred

- live K3 WISE WebAPI validation.
- live SQL Server driver integration.
- K3 WISE error-code translation dictionary.
- multi-account-set dispatch.
- complex BOM, substitute material, approval workflow, and compensation
  transactions.
- concurrency and idempotency hardening against a real K3 WISE production
  environment.
