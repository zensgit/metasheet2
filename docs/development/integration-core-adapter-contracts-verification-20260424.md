# Integration Core Adapter Contracts Verification - 2026-04-24

## Scope

Verify M1-PR2 for `plugin-integration-core`:

- Adapter registry enforces the required method contract.
- Read/upsert request normalizers provide stable runner inputs.
- HTTP adapter can test, list objects, read, and upsert through injected `fetch`.
- Runtime status exposes the registered adapter kind.
- Plugin manifest remains valid.

This branch is based after M1-PR1 / PR #1145, which introduced the external
system registry.

## Commands Run

```bash
pnpm -F plugin-integration-core test
pnpm validate:plugins
node --import tsx scripts/validate-plugin-manifests.ts
```

## Results

- `plugin-integration-core` package tests: passed, including 10 plugin-local
  smoke/unit checks.
- New `adapter-contracts.test.cjs`: passed.
- New `http-adapter.test.cjs`: passed.
- `node --import tsx scripts/validate-plugin-manifests.ts`: passed, 13/13 valid
  plugin manifests, 0 errors.
- `pnpm validate:plugins`: failed in this sandbox with the known `tsx` IPC
  `listen EPERM` issue before validation logic ran.

## Covered Behaviors

`adapter-contracts.test.cjs` covers:

- registering adapter factories by kind.
- duplicate kind rejection unless `replace: true`.
- factory output validation for required methods.
- unknown adapter kind typed failure.
- read request normalization and limit capping.
- upsert request normalization and record validation.
- read/upsert result shape helpers.
- unsupported operation helper typed failure.

`http-adapter.test.cjs` covers:

- `testConnection()` calls `healthPath`.
- static headers and credential-derived headers are applied.
- `listObjects()` reflects configured objects.
- `getSchema()` returns configured schema fields.
- `read()` sends limit, cursor, filters, and watermark query params.
- `read()` extracts nested records and next cursor.
- `upsert()` posts normalized records and key fields.
- read-only object rejects `upsert()`.
- non-HTTP base URLs are rejected.
- non-2xx HTTP responses throw `HttpAdapterError`.

Runtime smoke tests cover:

- `getStatus().adapters` is self-consistent with `listAdapterKinds()` when
  adapters are registered.
- communication namespace exposes `listAdapterKinds()` when adapter registry
  wiring is present.

For a PR2-only branch, hunk staging should leave only the generic `http`
adapter registered, so `getStatus().adapters` should evaluate to `['http']`.
The shared smoke tests intentionally avoid hard-coding this final value because
later stacked slices add K3 WISE and PLM adapters.

## Not Covered

- Live external HTTP systems.
- Pipeline runner dispatch.
- PR2-only adapter tests do not decrypt stored credentials. The current stacked
  integration-core path covers credential handoff through registry and runner
  tests.
- K3 WISE, PLM, Postgres, SQL Server, and MySQL adapters.
- Retry/backoff/rate-limit behavior.
