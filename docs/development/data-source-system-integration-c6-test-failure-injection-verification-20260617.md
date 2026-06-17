# Data Source System Integration C6-5b Test Failure Injection Verification

Date: 2026-06-17

## Scope

This verifies the C6-5b implementation of the default-off, sandbox-only,
server-owned test failure-injection seam for #2720.

The slice exists only because #2720 reached `HOLD_NO_SAFE_FAILURE_SHAPE` after
both real sandbox failure shapes were unavailable. It does not authorize
production, batch, K3, raw SQL, DDL, trigger, stored-procedure, generic query,
or a broad runtime failure hook.

## Implementation Summary

- Runtime config:
  - `METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED=true` is the deploy/process
    gate.
  - `INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON` is the server-owned
    config gate.
- The server config must pin:
  - `enabled=true`;
  - `pipelineId`;
  - `targetSystemId`;
  - `targetDataSourceId`;
  - `targetObject`;
  - `environment=sandbox`;
  - optional `failWriteOrdinal` (default `1`).
- The browser/request body cannot enable, disable, parameterize, or target the
  injection.
- The mutable external-system config is not trusted as sandbox proof.
- The injected row failure occurs after token consumption and revision
  recompute, inside the existing per-row write loop, and is handled by the
  normal row-level failure/dead-letter/provenance path.

## Verification Commands

```bash
node plugins/plugin-integration-core/__tests__/external-write-dry-run.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-config.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false --project tsconfig.json
pnpm --filter plugin-integration-core test
git diff --check
```

All commands passed locally.

## Test Locks

- default-off: JSON config without the deploy flag does not inject.
- server-config gate: deploy flag + non-targeted server config does not inject.
- sandbox proof: `environment=sandbox` must come from server runtime config.
- target pinning: `targetDataSourceId` and `targetObject` must match the loaded
  target before capability checks or writes.
- client rejection: dry-run/apply request bodies reject injection/scope fields
  before loading the pipeline.
- token/revision first: active-to-active `failWriteOrdinal` drift is a revision
  mismatch before writes.
- single-row failure: exactly one row receives
  `C6_TEST_INJECTED_ROW_FAILURE`.
- clean sibling write: at least one sibling reaches `insertRows` in the same
  route-level apply.
- partial token consumption: partial injected apply consumes the dry-run token;
  reuse returns `C6_WRITE_DRY_RUN_TOKEN_INVALID` and performs no additional
  write or dead-letter.
- values-free evidence: public response, persisted run provenance, and
  dead-letter evidence contain tokens/counts/fingerprints only, not source row
  values.

## Subagent Review

Security/boundary review found one high-severity issue in the first draft:
sandbox enforcement trusted `target.config.environment`, which is mutable
external-system config. Fixed by moving sandbox proof and target binding to
server runtime config (`environment`, `targetDataSourceId`, `targetObject`) and
adding mismatch tests.

State-machine/test review found three non-blocking coverage gaps:

- `failWriteOrdinal` active-to-active drift was not explicitly revision-bound.
- partial injected apply did not explicitly prove token consumption.
- values-free assertions checked only the injected failed row, not the clean
  sibling.

All three were fixed with helper and route-level assertions.

## Remaining Gate

C6-5 is still not complete until C6-5c publishes a sandbox package and #2720
passes entity-machine evidence:

- injected row failure is observed values-free;
- at least one clean sibling writes;
- dead-letter/provenance are values-free;
- re-pull proves no duplicate target rows;
- the test-injection deploy flag is disabled after validation.
