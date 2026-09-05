# Time Machine D8 operational observability verification report

**Status:** MAIN@`177cafd3e34f...` LOCAL REPLAY VERIFIED / LATER MAIN DRIFT
PENDING / DRAFT-HOLD. Historical remote
exact-head evidence remains bound to its historical heads. Current remote CI,
Ready, PR merge, staging, flags, deployment, production, and tenant UAT are not
claimed. The commit that updates this report is report-only and does not alter
the current verified code tree.

## 1. Exact evidence binding

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
- Observed-and-tested main replay parent: `177cafd3e34f30b5fc2682b3d392684c92fe67fe`
- Later live GitHub main ref reported by coordinator:
  `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`; NOT FETCHED, AUDITED, MERGED,
  OR TESTED in this worktree; coordinator delta packet pending
- True merge: `f2ba2ea40c56b350382f2c2a3187a02aff3d24fd`
- True-merge ordered parents: `6791bc7de4d3a543f7dfb940f03857256d2c6c1e`,
  `177cafd3e34f30b5fc2682b3d392684c92fe67fe`
- Prior evidence code head: `8ac37f707f2c40a437ae644d91ac77574d873e0d`
- Prior evidence code tree: `0fb61fce3bbf45471ee36aa1d8e23ab7f1965abd`
- Corrective current evidence code head: `57fc9d592622f94864b6334712dc882d4137188b`
- Corrective current evidence code tree: `e209c4924b8c1eb3f96dad08f27eb98cb7db8549`
- Worktree: `/private/tmp/codex-tm-d8-closeout-replay-20260905`
- Remote PR: `#5393`
- Historical remote exact-head result: `25 SUCCESS / 1 intentional SKIPPED / 0
  failure / 0 pending` at both `666e01474980...` and `6791bc7de4...`
- Corrective evidence code-head remote result: NOT RUN; no push was performed
- Merged-main SHA: `NOT AVAILABLE`

## 2. Local gates

| Gate | Result |
|---|---|
| Observability, metrics, application, restore-worker, server-wiring, and metrics-endpoint tests | Historical 6 files / 46 tests PASS; current local replay 6 files / 47 tests PASS |
| Final main@`177cafd3e34f...` replay focused D8 tests | 6 files / 47 tests PASS at `57fc9d592622...` |
| `pnpm --filter @metasheet/core-backend type-check` | PASS |
| Scoped source ESLint | PASS with 0 errors and the same 22 historical `src/index.ts` warnings; the three D8 production modules add none |
| Cache build and tests | 3 files / 16 tests PASS |
| `git diff --check` | PASS |
| Database/migration | NOT RUN; no DB or migration change |
| Object store / KMS / external I/O | NOT RUN; no production provider or KMS proof is claimed |
| Staging / real tenant / deployment / production | NOT RUN |

The focused suite included:

- `multitable-recovery-archive-observability.test.ts`
- `multitable-recovery-archive-metrics.test.ts`
- `multitable-recovery-archive-application.test.ts`
- `multitable-recovery-archive-restore-worker.test.ts`
- `metasheet-recovery-archive-wiring.test.ts`
- `metrics-endpoint.test.ts`

## 3. Discriminating mutations

| Mutation | Required red result | Final state |
|---|---|---|
| Remove application `onResult` forwarding | observer producer test failed because `recordRun` was called 0 times | Restored; focused suite green |
| Remove `drain_failed` lifecycle event | bounded-drain failure test failed because the second lifecycle event was absent | Restored; focused suite green |
| Ignore extra run-result keys | values-free closed-shape test accepted a `sheetId` property and failed its throw assertion | Restored; focused suite green |
| Remove `tick_failed` from the exhaustive outcome record | `tsc` failed with TS1360 because the `RecoveryArchiveRestoreWorkerRunKind` member was missing | Restored; typecheck and focused suite green |
| Remove `src/types/express.d.ts` from the cache include set | cache TypeScript failed on the existing `Request.user` fields | Restored; cache build green |
| Remove `src/middleware/api-token-auth.ts` from the cache include set | cache TypeScript failed on the existing API-token audit request fields | Restored; cache build green |

The 2026-09-05 replay added and executed these discriminating mutations at the
prior and corrective evidence code trees:

| Mutation | Required red result | Final state |
|---|---|---|
| Remove worker `onResult` exception containment | restore-worker test rejected with `observer unavailable` instead of resolving the worker outcome | Restored byte-exact; focused suite green |
| Remove application lifecycle exception containment | application tests failed on start and replaced the canonical drain error with the observer error | Restored byte-exact; focused suite green |
| Remove application `onResult` forwarding | application test observed zero `recordRun` calls | Restored byte-exact; focused suite green |
| Remove exact run-result key census | extra-`sheetId` negative accepted the result | Restored byte-exact; observability test green |
| Omit one zero-initialized run outcome | registry census observed 11 outcome series instead of 12 | Restored byte-exact; metrics test green |
| Omit drain-success zero-initialization against the prior post-event-only test | old metrics test remained green because recording `drained` created `success=1`; this reproduced the evidence gap | Restored byte-exact before the corrective test was added |
| Omit drain-success zero-initialization against the corrective initial-state test | initial registry census contained only the failure series | Restored byte-exact; metrics test green |
| Omit drain-failure zero-initialization against the corrective initial-state test | initial registry census contained only the success series | Restored byte-exact; metrics test green |
| Remove `drain_failed` lifecycle notification | bounded-drain test observed only the started event instead of the required second failure event | Restored byte-exact; application test green |
| Remove `tick_failed` from the exhaustive run-outcome record | typecheck failed with `TS1360` because the required member was missing | Restored byte-exact; typecheck green |
| Remove `src/types/express.d.ts` from cache roots | cache TypeScript failed on existing `Request.user` fields | Restored byte-exact; cache gate green |
| Remove `src/middleware/api-token-auth.ts` from cache roots | cache TypeScript failed on existing API-token audit request fields | Restored byte-exact; cache gate green |

The prior exception-containment and 12-run-series evidence remains bound to
`8ac37f707f2c...`, tree `0fb61fce3bbf...`. The pre-event drain-series census
and its independent success/failure mutations are bound to corrective code head
`57fc9d592622...`, tree `e209c4924b8c...`. No fresh independent model review
was run for the corrective code head.

The initial observability test also failed before implementation because the
production module did not exist. The metrics test failed before registry wiring
because the production observer export was absent.

## 4. Security and privacy checks

- Only closed enums are metric labels.
- Aggregate counts must be non-negative safe integers.
- Extra result keys fail before any metric callback.
- Invalid lifecycle events fail before gauge or counter mutation.
- Metric exposition contains no `sheetId`, `generationId`, `keyId`, or
  `providerUri` token.
- Observer exceptions cannot change worker or drain semantics.
- The source-default/flags-off test path leaves the factory, database, worker,
  timer, and observer untouched; the live environment was NOT PROBED.

## 5. Evidence levels

| Level | State |
|---|---|
| Source and local focused tests | Current local replay PASS at `57fc9d592622...` (6 files / 47 tests) |
| Local typecheck/lint/diff | Current typecheck and diff check PASS; scoped lint has 0 errors and the same 22 historical `src/index.ts` warnings |
| Independent exact-range model review | Terra high `P1=0 / P2=0 / P3=0` after the bounded exhaustiveness fix-forward; fresh replay review at `666e01474980...` also returned `0 / 0 / 0` |
| Draft PR exact-head CI | Historical heads `666e01474980...` and `6791bc7de4...` reached `25 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending`; current local code head remote CI is NOT RUN |
| Ready / merge | NOT AUTHORIZED by this report |
| Merged-main rerun | NOT RUN |
| D7 staging | NOT RUN / OWNER GATE |
| Flags / dispatch / deployment / production | Source-default gate OFF; live environment NOT PROBED; dispatch, deployment, and production NOT RUN / OWNER GATE |
| Real tenant UAT | NOT RUN |

## 6. Residual risk and next gates

This slice does not close production provider/KMS, live archive creation,
retention purge, or staging acceptance. A later operations packet must select
the independent durability domain and key custody, define retention/legal-hold
policy and alert thresholds, execute the D7 runbook, and bind evidence to the
deployed exact SHA. Whole-sheet resurrection remains PARKED and is not a gate
for this D8 candidate.
