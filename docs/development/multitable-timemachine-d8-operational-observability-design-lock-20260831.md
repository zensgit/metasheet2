# Time Machine D8 operational observability design lock

**Status:** RATIFIED-BY-DEFAULT-2026-08-31 for local development and Draft/HOLD
publication only. This lock does not authorize flags, provider credentials,
staging, dispatch, deployment, production, or real customer data.

**Baseline:** `origin/main@25635e67db5145a5998499c4adc8f030e156daf7`.

**Historical Draft/HOLD publication binding:** historical final replay base
`24942c70fb07133b580250c00aecbc208aa2f8e8`, code-bearing head
`666e01474980d5e16ff9ebdc49f686c5afb23fb5`, tree
`e49d1348ab8cc3602e9c9158fb60196b5e190c05`, PR `#5393`. That exact head
completed `25 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending`.
This binding does not change the ratification baseline or authorize Ready,
merge, flags, dispatch, staging, deployment, production, or tenant UAT.

**2026-09-05 bounded local replay binding:** observed-and-tested main parent
`177cafd3e34f30b5fc2682b3d392684c92fe67fe`; true merge
`f2ba2ea40c56b350382f2c2a3187a02aff3d24fd` with ordered parents
`6791bc7de4d3a543f7dfb940f03857256d2c6c1e` and
`177cafd3e34f30b5fc2682b3d392684c92fe67fe`; prior evidence code head
`8ac37f707f2c40a437ae644d91ac77574d873e0d`, tree
`0fb61fce3bbf45471ee36aa1d8e23ab7f1965abd`; corrective evidence code head
`57fc9d592622f94864b6334712dc882d4137188b`, tree
`e209c4924b8c1eb3f96dad08f27eb98cb7db8549`. The corrective test queries the
registry before any worker or lifecycle event and requires all 12 run outcomes,
both drain outcomes, and the running gauge to be zero-initialized. The replay is
local only; remote exact-head CI is NOT RUN. The historical remote proof above
remains evidence for its historical head and is not inherited by either local
code head.

After these local gates completed, the coordinator reported that the live GitHub
main ref had advanced to `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
That newer ref was not fetched, audited, merged, or tested in this worktree; its
delta and any bounded replay decision remain pending the coordinator packet.

## 1. Objective

Make the existing recovery archive restore worker and its bounded shutdown drain
observable through the shared Prometheus registry. Operators must be able to
distinguish closed worker outcomes, aggregate work, running state, and drain
failure without introducing a provider, KMS adapter, new API, new flag, or
identity-bearing telemetry.

The feature's source-default gate remains OFF. The live environment was NOT
PROBED. An exact-ON process without an injected production archive composition
continues to fail closed.

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

1. Source-default gate OFF and the flags-off test path: do not resolve the
   composition factory, DB pool, object store, or KMS; emit no worker lifecycle
   event.
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
- `packages/core-backend/tests/unit/multitable-recovery-archive-restore-worker.test.ts`
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
- Mutation: remove either observer-exception containment boundary; the worker
  or application test must fail without replacing canonical lifecycle results.
- Mutation: remove drain-failure lifecycle recording; the shutdown test must fail.
- Mutation: allow an extra run-result key; the values-free closed-shape test must fail.
- Mutation: omit one zero-initialized run outcome; the registry census must fail.
- Mutation: omit either zero-initialized drain outcome; the initial registry
  census must fail before any event is recorded.
- Mutation: omit one member from the exhaustive run-outcome record; TypeScript
  must fail with `TS1360`.
- Source-default/flags-off test proof that factory, DB, worker, timer, and
  observer remain untouched; live environment inspection is not implied.
- Exact-head remote CI before any Ready request.

## 8. Deferred owner and operations decisions

The following remain explicit owner/operations gates: provider and independent
durability domain; KMS/HSM hierarchy, rotation, retirement, and break-glass;
archive retention and legal-hold/purge policy; alert thresholds and recipients;
staging bucket/test key and secret injection; D7 staging execution; flags;
deployment; and production.
