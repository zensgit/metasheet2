# Integration Core Adapter Contracts Design - 2026-04-24

## Context

M1-PR1 adds the external-system registry. The next backend slice needs a stable
internal adapter shape before the pipeline runner can read PLM/API/DB sources
and write ERP/API/DB targets.

This PR keeps the adapter surface local to `plugin-integration-core`. It does
not expose a platform-wide plugin adapter API yet, because K3 WISE and Yuantus
PLM still need PoC validation before the contract should be made public.

## Decision

Add two plugin-local modules:

- `plugins/plugin-integration-core/lib/contracts.cjs`
- `plugins/plugin-integration-core/lib/adapters/http-adapter.cjs`

The adapter contract has five methods:

```js
testConnection(input?)
listObjects(input?)
getSchema(input?)
read(input)
upsert(input)
```

Every registered adapter must implement all five methods. Unsupported
operations must fail with `UnsupportedAdapterOperationError` instead of leaving
methods undefined. This keeps the future runner simple: it can dispatch a known
method set and handle typed failures.

## Contract Normalization

`contracts.cjs` owns the shared normalization and result shapes:

- `normalizeExternalSystemForAdapter(system)`
- `normalizeReadRequest(input)`
- `normalizeUpsertRequest(input)`
- `createReadResult(result)`
- `createUpsertResult(result)`
- `createAdapterRegistry()`

Read requests normalize to:

```js
{
  object,
  limit,
  cursor,
  filters,
  watermark,
  options
}
```

Upsert requests normalize to:

```js
{
  object,
  records,
  keyFields,
  mode,
  options
}
```

The default read limit is `1000`; the hard cap is `10000`.

## HTTP Adapter

`http-adapter.cjs` is config-driven and dependency-injectable:

```js
createHttpAdapter({
  system,
  fetchImpl,
  logger
})
```

The adapter reads from `system.config`:

```js
{
  baseUrl,
  healthPath,
  headers,
  apiKeyHeader,
  timeoutMs,
  objects: {
    materials: {
      path,
      upsertPath,
      recordsPath,
      nextCursorPath,
      schema,
      operations
    }
  }
}
```

Credentials are not read from storage by the adapter. The current runner loads
systems through `getExternalSystemForAdapter()` when available, so adapters
receive hydrated `system.credentials` while public registry reads remain safe.
Supported credential header mappings are:

- `bearerToken` -> `Authorization: Bearer ...`
- `apiKey` -> configurable header, default `X-API-Key`
- `username/password` -> basic auth

## Runtime Exposure

`index.cjs` now creates an adapter registry during activation and registers:

```js
http
```

The `integration-core` communication namespace exposes:

```js
listAdapterKinds()
```

`getStatus()` includes:

```json
{
  "adapters": ["http"]
}
```

No runtime API in this slice executes arbitrary adapter reads or writes. Runner
execution is intentionally deferred to the next PR.

## Trade-Offs

- The HTTP adapter is intentionally generic but not a full API designer.
- It supports path-based record/cursor extraction, not arbitrary user JS.
- It relies on injected `fetch` for tests and Node global `fetch` at runtime.
- It validates base URLs as `http` or `https` and rejects absolute object paths
  so object configs cannot silently escape the configured base URL.

## Deferred

- Pipeline runner dispatch.
- Postgres/MySQL/Yuantus PLM/K3 WISE concrete adapters.
- REST endpoints for adapter test/read/upsert.
- Backoff/retry/rate-limit behavior for live HTTP systems.
