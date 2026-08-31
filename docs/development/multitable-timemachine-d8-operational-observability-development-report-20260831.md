# Time Machine D8 operational observability development report

**Status:** LOCAL CANDIDATE / DRAFT-HOLD. This report is not Ready, merge,
staging, flag, deployment, production, or tenant-UAT evidence.

## 1. Exact binding

- Base: `25635e67db5145a5998499c4adc8f030e156daf7`
- Product/design checkpoint: `9c093f9b88636faf917b909f419ea652825fc8c5`
- Product/design tree: `ec45c33c4ff5d35b6e04c1c4e713aa5c99396e5d`
- Branch: `codex/tm-d8-operational-observability-20260831`
- Scope: 9 files, 467 insertions, 2 deletions
- Remote PR and exact-head CI: `NOT RUN` at this report revision

The contract is
`multitable-timemachine-d8-operational-observability-design-lock-20260831.md`.

## 2. Delivered behavior

The existing recovery archive worker now publishes closed, fixed-cardinality
operational evidence to the shared Prometheus registry:

- one run count by the worker's closed outcome enum;
- aggregate swept-job and applied-chunk counts;
- a running gauge set only by application lifecycle;
- successful and failed bounded-drain counts.

`createRecoveryArchiveApplication` forwards its existing worker `onResult`
callback to an injected observer. Worker start, successful drain, and failed
drain are recorded without changing the existing worker or shutdown result.
Telemetry failures are isolated and cannot convert a worker failure to success
or a successful worker run to failure.

## 3. Closed and values-free boundary

The observer accepts exactly `kind`, `swept`, and `chunks`. It rejects:

- unknown outcome strings;
- negative or fractional aggregate counts;
- any additional property, including identity-bearing fields.

Prometheus labels are restricted to the closed run outcome and
`success|failure` drain outcome. No sheet, generation, archive, actor, tenant,
provider URI, object key, key ID, or error text is emitted.

## 4. Flag-OFF parity

When either recovery archive flag is not exact `true`, the application still
returns before:

- the composition factory;
- the database pool resolver;
- worker construction or timer scheduling;
- observer callbacks;
- object-store or KMS access.

No new flag was added and no existing flag was enabled.

## 5. File census

Production:

- `packages/core-backend/src/multitable/recovery-archive-observability.ts`
- `packages/core-backend/src/multitable/recovery-archive-application.ts`
- `packages/core-backend/src/metrics/metrics.ts`
- `packages/core-backend/src/index.ts`

Tests:

- `packages/core-backend/tests/unit/multitable-recovery-archive-observability.test.ts`
- `packages/core-backend/tests/unit/multitable-recovery-archive-metrics.test.ts`
- `packages/core-backend/tests/unit/multitable-recovery-archive-application.test.ts`
- `packages/core-backend/tests/unit/metasheet-recovery-archive-wiring.test.ts`

Contract:

- `docs/development/multitable-timemachine-d8-operational-observability-design-lock-20260831.md`

There is no migration, database, OpenAPI, workflow, provider, KMS, retention,
purge, flag, frontend, or whole-sheet undelete change.

## 6. Honest completion boundary

This checkpoint improves operational visibility for the already implemented
live-sheet recovery archive worker. It does not make Recovery Archive production
ready by itself.

Still owner-gated or not implemented:

- production object-store and KMS/HSM composition;
- archive capture/finalization callers;
- retention deletion intent, legal-hold/purge orchestration, and cleanup worker;
- alert thresholds, receivers, dashboards, and on-call routing;
- D7 staging fault/scale execution;
- flags, dispatch, deployment, production, and tenant UAT.

Deleted whole-sheet resurrection remains explicitly PARKED. Record history,
record restore, record trash restore, config undelete, and live-sheet archive
remain separate existing surfaces with their own permission and flag contracts.
