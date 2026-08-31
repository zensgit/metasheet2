# Time Machine D8 operational observability design lock

**Status:** RATIFIED-BY-DEFAULT-2026-08-31 for local development and Draft/HOLD
publication only. This lock does not authorize flags, provider credentials,
staging, dispatch, deployment, production, or real customer data.

**Baseline:** `origin/main@25635e67db5145a5998499c4adc8f030e156daf7`.

## 1. Objective

Make the existing recovery archive restore worker and its bounded shutdown drain
observable through the shared Prometheus registry. Operators must be able to
distinguish closed worker outcomes, aggregate work, running state, and drain
failure without introducing a provider, KMS adapter, new API, new flag, or
identity-bearing telemetry.

The feature remains source-default OFF. An exact-ON process without an injected
production archive composition continues to fail closed.

## 2. In scope

- A closed observability adapter for restore-worker outcomes and lifecycle.
- Shared Prometheus metrics exposed through the existing `/metrics/prom` route.
- Application wiring from the existing worker `onResult` callback.
- Lifecycle evidence for worker start, successful drain, and failed drain.
- Unit, wiring, registry, values-free, and mutation evidence.
- Development and verification reports bound to exact local and remote heads.

## 3. Explicitly out of scope

- Recovery of a deleted whole sheet. Whole-sheet resurrection is PARKED.
- Object-store or KMS/HSM provider selection and composition.
- Archive capture/finalization callers or retention deletion workers.
- Legal-hold/purge orchestration, deletion intent, or automatic cleanup.
- New database schema, migration, OpenAPI route, workflow, or feature flag.
- Alert thresholds, receivers, paging policy, dashboards, or SLO ownership.
- Staging execution, tenant UAT, flags, dispatch, deployment, and production.

## 4. Closed metric contract

| Metric | Labels | Meaning |
|---|---|---|
| `metasheet_recovery_archive_worker_runs_total` | `outcome` | One completed worker tick, classified by the worker's closed outcome enum |
| `metasheet_recovery_archive_worker_swept_total` | none | Aggregate expired jobs swept by completed ticks |
| `metasheet_recovery_archive_worker_chunks_total` | none | Aggregate restore chunks applied by completed ticks |
| `metasheet_recovery_archive_worker_running` | none | `1` after start; `0` only after a successful drain |
| `metasheet_recovery_archive_worker_drain_total` | `outcome=success|failure` | Bounded shutdown drain results |

The only allowed run outcomes are:

`idle`, `completed`, `paused_retryable`, `abandoned`, `claim_contended`,
`lease_lost`, `yielded`, `stopped`, `sweep_failed`, `selection_failed`,
`terminalization_failed`, and `tick_failed`.

No sheet, generation, archive, actor, tenant, provider URI, object key, key ID,
error text, or other dynamic value may be a label or log value. Run-result input
must contain exactly `kind`, `swept`, and `chunks`; unknown outcomes, negative or
fractional counts, and extra fields fail closed before any metric is changed.

## 5. Lifecycle state machine

1. Flags OFF: do not resolve the composition factory, DB pool, object store, or
   KMS; emit no worker lifecycle event.
2. Exact flags ON and successful worker boot: set running to `1`.
3. Each completed tick: record one closed outcome and non-zero aggregate counts.
4. Successful bounded stop: set running to `0` and increment drain `success`.
5. Rejected or timed-out stop: keep running at its last conservative state and
   increment drain `failure`; the existing shutdown path remains non-zero and
   does not close the database pool.
6. Any telemetry sink failure is swallowed at the observability boundary and
   cannot change worker execution or shutdown semantics.

## 6. File boundary

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

Docs:

- this design lock;
- one D8 development report;
- one D8 verification report.

Any database, migration, API, workflow, provider, KMS, retention, purge, or flag
file is a scope stop.

## 7. Required gates

- Focused observability, metrics, application, and server wiring unit tests.
- Recovery worker and shutdown neighbors.
- Core-backend typecheck and scoped ESLint.
- `git diff --check` and exact file census.
- Mutation: remove `onResult` forwarding; the producer test must fail.
- Mutation: remove drain-failure lifecycle recording; the shutdown test must fail.
- Mutation: allow an extra run-result key; the values-free closed-shape test must fail.
- Flags-OFF proof that factory, DB, worker, timer, and observer remain untouched.
- Exact-head remote CI before any Ready request.

## 8. Deferred owner and operations decisions

The following remain explicit owner/operations gates: provider and independent
durability domain; KMS/HSM hierarchy, rotation, retirement, and break-glass;
archive retention and legal-hold/purge policy; alert thresholds and recipients;
staging bucket/test key and secret injection; D7 staging execution; flags;
deployment; and production.
