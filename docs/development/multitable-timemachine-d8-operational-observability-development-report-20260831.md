# Time Machine D8 operational observability development report

**Status:** DRAFT-HOLD / MAIN@`177cafd3e34f...` LOCAL REPLAY VERIFIED / LATER
MAIN DRIFT PENDING. This report is not
Ready, remote exact-head CI, merge, staging, flag, deployment, production, or
tenant-UAT evidence. Historical remote proofs remain explicitly bound to their
historical heads. The commit that updates this report is a report-only child of
the current verified code head and changes no implementation or CI
configuration.

## 1. Exact binding

- Ratification baseline: `25635e67db5145a5998499c4adc8f030e156daf7`
- Historical final replay base: `24942c70fb07133b580250c00aecbc208aa2f8e8`
- Product/design checkpoint: `9c093f9b88636faf917b909f419ea652825fc8c5`
- Product/design tree: `ec45c33c4ff5d35b6e04c1c4e713aa5c99396e5d`
- Outcome-exhaustiveness fix-forward: `af90e770a21ee28bc97b2cead42560092fc6c484`
- Pre-replay implementation tree: `509e493238f66e38ed1599a679be0e0525cfee27`
- Cache-CI config fix-forward: `e85616da1007eca3664f686d8e19563814970d82`
- Code-bearing remote head: `666e01474980d5e16ff9ebdc49f686c5afb23fb5`
- Code-bearing tree: `e49d1348ab8cc3602e9c9158fb60196b5e190c05`
- Historical report carrier: `6791bc7de4d3a543f7dfb940f03857256d2c6c1e`
- Historical report-carrier tree: `e9ccd921569d79254c753736c9b22d3b07ca9495`
- Observed-and-tested main replay parent: `177cafd3e34f30b5fc2682b3d392684c92fe67fe`
- Later live GitHub main ref reported by coordinator:
  `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`; NOT FETCHED, AUDITED, MERGED,
  OR TESTED in this worktree; coordinator delta packet pending
- True merge: `f2ba2ea40c56b350382f2c2a3187a02aff3d24fd`
- True-merge ordered parents: `6791bc7de4d3a543f7dfb940f03857256d2c6c1e`,
  `177cafd3e34f30b5fc2682b3d392684c92fe67fe`
- True-merge tree: `a04be3100a6fcd4787e0cd8a646c50458194aecc`
- Prior evidence code head: `8ac37f707f2c40a437ae644d91ac77574d873e0d`
- Prior evidence code tree: `0fb61fce3bbf45471ee36aa1d8e23ab7f1965abd`
- Corrective current evidence code head: `57fc9d592622f94864b6334712dc882d4137188b`
- Corrective current evidence code tree: `e209c4924b8c1eb3f96dad08f27eb98cb7db8549`
- Branch: `codex/tm-d8-closeout-replay-20260905`
- Scope including this development report and its verification report: 12 files,
  729 insertions, 2 deletions at the code-bearing remote head
- Remote PR: `#5393`
- Historical remote exact-head CI: `25 SUCCESS / 1 intentional SKIPPED / 0
  failure / 0 pending` at both `666e01474980...` and the report-only
  `6791bc7de4...` carrier
- Corrective evidence code-head remote CI: NOT RUN; no push was performed
- Corrective evidence code-head delta from tested main replay parent: 13 files,
  858 insertions, 2 deletions

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

## 4. Source-default gate parity

The source-default gate is OFF. In the flags-off test path, when either recovery
archive flag is not exact `true`, the application still returns before:

- the composition factory;
- the database pool resolver;
- worker construction or timer scheduling;
- observer callbacks;
- object-store or KMS access.

No new flag was added and no existing flag was enabled by this branch. The live
environment was NOT PROBED.

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
- `packages/core-backend/tests/unit/multitable-recovery-archive-restore-worker.test.ts`
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
Strict E2E gate. The historical main replay head `666e01474980...` has
ordered parents `a78abf3933da...` and `24942c70fb07...`. Its first-parent
delta is only `docs/integration-consolidation-minimal-plan-20260901.md`; its
second-parent delta is the same 12 D8 files, all byte-identical to the prior
code-bearing candidate. A fresh Terra high replay review returned
`P1=0 / P2=0 / P3=0`. The exact head repeated the complete remote result:
`25 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending`, including Node
18, Node 20, Web Tests, and `core-backend-cache`.

The 2026-09-05 local replay true-merged observed main `177cafd3e34f...` without
conflict. The
post-merge delta retained the original 12 PR paths byte-for-byte except for the
automatic `src/index.ts` composition with that tested main. The prior evidence-only
code child at `8ac37f707f2c...` changed exactly three existing unit-test files:
it made run-observer and lifecycle-observer exceptions throw, proved
worker/application outcomes remain unchanged, and enumerated all 12
zero-initialized worker outcome series.

Coordinator review then identified an evidence gap, not a production defect:
the metrics test recorded `drained` before exposition, so deleting only the
drain-success initializer still produced `success=1` and the old test remained
green. The corrective code child at `57fc9d592622...`, tree
`e209c4924b8c...`, changes only that metrics test. It captures exposition before
any `recordRun` or `recordLifecycle` call and asserts exactly 12 zero-valued run
series, exactly two zero-valued drain series, and running `0`, while retaining
the post-event assertions.

The gap was reproduced: omitting drain-success initialization left the old test
green. Against the corrective test, independently omitting success or failure
initialization made the metrics test red. Removing the `drain_failed`
notification made the application test red, and removing `tick_failed` from the
exhaustive record made typecheck fail with `TS1360`. Every production mutation
was restored byte-exact. Final local gates at `57fc9d592622...` are 6 focused
files / 47 tests PASS, core-backend typecheck PASS, cache build/tests 3 files /
16 tests PASS, `git diff --check` PASS, and scoped source ESLint `0 errors / 22
warnings`. All 22 warnings are the historical `src/index.ts` baseline; the
three D8 production modules add none. No fresh independent model review was run
for the corrective code child.

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

Production provider/KMS, staging, real-tenant, deployment, and production proof
were NOT RUN and are not claimed by the current local replay. The source-default
gate is OFF; the live environment was NOT PROBED.

Deleted whole-sheet resurrection remains explicitly PARKED. Record history,
record restore, record trash restore, config undelete, and live-sheet archive
remain separate existing surfaces with their own permission and flag contracts.
