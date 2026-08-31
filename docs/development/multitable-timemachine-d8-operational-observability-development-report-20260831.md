# Time Machine D8 operational observability development report

**Status:** DRAFT-HOLD / CODE-BEARING EXACT HEAD REMOTE-GREEN. This report is
not Ready, merge, staging, flag, deployment, production, or tenant-UAT
evidence. The commit that updates this report is a report-only child of the
verified code-bearing head and changes no implementation or CI configuration.

## 1. Exact binding

- Base: `25635e67db5145a5998499c4adc8f030e156daf7`
- Product/design checkpoint: `9c093f9b88636faf917b909f419ea652825fc8c5`
- Product/design tree: `ec45c33c4ff5d35b6e04c1c4e713aa5c99396e5d`
- Outcome-exhaustiveness fix-forward: `af90e770a21ee28bc97b2cead42560092fc6c484`
- Current implementation tree: `509e493238f66e38ed1599a679be0e0525cfee27`
- Cache-CI config fix-forward: `e85616da1007eca3664f686d8e19563814970d82`
- Code-bearing remote head: `c0762ee4d79950ec3625311a1cabb39b1b2012ce`
- Code-bearing tree: `7b10d0d5a35093babb72d6cf5a0c31480725a4d6`
- Branch: `codex/tm-d8-operational-observability-20260831`
- Scope including this development report and its verification report: 12 files,
  705 insertions, 2 deletions at the code-bearing remote head
- Remote PR: `#5393`
- Remote exact-head CI: `25 SUCCESS / 1 intentional SKIPPED / 0 failure /
  0 pending` at `c0762ee4d799...`

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

The run-outcome authority is an exhaustive
`Record<RecoveryArchiveRestoreWorkerRunKind, true>`. The exported runtime list,
validation set, and zero-initialized Prometheus labels are all derived from that
record. Adding a worker outcome without updating observability is therefore a
compile-time error rather than a silently dropped metric.

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

CI configuration:

- `packages/core-backend/tsconfig.cache.tests.json`

Contract:

- `docs/development/multitable-timemachine-d8-operational-observability-design-lock-20260831.md`

There is no migration, database, OpenAPI, workflow, provider, KMS, retention,
purge, flag, frontend, or whole-sheet undelete change.

## 6. Independent review

Terra high reviewed the original exact range and returned `P1=0 / P2=0 /
P3=1`; the P3 was the missing compile-time exhaustiveness lock for worker run
outcomes. The fix-forward at `af90e770a21e...` added that lock and an exact
runtime-list oracle. A fresh narrow Terra review of the two-file fix returned
`P1=0 / P2=0 / P3=0`.

The first Draft head exposed a pre-existing cache-build configuration gap:
`tsconfig.cache.tests.json` did not load the existing Express request
augmentations, so transitively compiled multitable sources failed TypeScript.
The one-file fix-forward adds those two existing declaration roots. Luna's
read-only diagnosis confirmed the minimal file boundary and returned no
additional P2/P3 finding. This is a CI compilation fix only; it changes no
runtime request behavior. The replacement code-bearing head passed
`core-backend-cache`, Node 18, Node 20, Web Tests, migration/recovery guards,
and every other reported context; the only skipped context was the intentional
Strict E2E gate.

## 7. Honest completion boundary

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
