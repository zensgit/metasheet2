# Integration Core REST API Verification - 2026-04-24

## Scope

Verify the REST control plane for `plugin-integration-core`:

- route registration during plugin activation.
- read/write auth guard behavior.
- tenant scope injection and mismatch rejection.
- external system list/upsert/get/test.
- pipeline list/upsert/get/run/dry-run.
- run and dead-letter listing.
- dead-letter replay endpoint.
- consistent error response shape.

## Commands Run

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Results

- `plugin-integration-core` package tests: passed.
- New `http-routes.test.cjs`: passed.
- Plugin manifest validation through `node --import tsx`: passed, 13/13 valid,
  0 errors.
- `git diff --check`: passed.

`pnpm validate:plugins` was also attempted and failed before validation due to
the known sandbox `tsx` IPC `listen EPERM` restriction. The direct
`node --import tsx` manifest validation above passed.

## Covered Behaviors

Expected route test coverage:

- unauthenticated write request is rejected and does not reach services.
- tenant mismatch is rejected.
- non-admin users without tenant context are rejected.
- successful external-system and pipeline writes receive scoped tenant input.
- caller-supplied `createdBy` is ignored in favor of the authenticated actor.
- run routes strip internal runner fields such as `sourceRecords`,
  `allowInactive`, caller-supplied `triggeredBy`, and arbitrary `details`.
- external-system test route uses the internal credential-aware registry method
  and does not return credentials.
- validation and not-found service errors map to `400` and `404`.
- dead-letter list redacts payloads for non-admin read callers.
- admin `includePayload=true` returns payloads with sensitive fields redacted.
- route errors return `ok:false` with `error.code`.
- `dry-run` calls runner with `dryRun: true`.
- dead-letter replay calls `replayDeadLetter()`.

Additional package-level coverage from this slice:

- plugin activation registers health plus 13 REST routes.
- `POST /api/integration/pipelines/:id/dry-run` returns preview-style runner output without target writes.
- `POST /api/integration/dead-letters/:id/replay` returns replayed dead-letter status.

## Not Covered

- Real JWT middleware.
- Browser/frontend flows.
- OpenAPI generated client.
- Live external PLM/ERP systems.
