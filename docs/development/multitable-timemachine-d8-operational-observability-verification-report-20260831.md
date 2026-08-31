# Time Machine D8 operational observability verification report

**Status:** LOCAL VERIFIED / REMOTE PENDING. Exact-head CI, merge, merged-main,
staging, flags, deployment, production, and tenant UAT are not claimed.

## 1. Exact evidence binding

- Base: `25635e67db5145a5998499c4adc8f030e156daf7`
- Product/design checkpoint: `9c093f9b88636faf917b909f419ea652825fc8c5`
- Product/design tree: `ec45c33c4ff5d35b6e04c1c4e713aa5c99396e5d`
- Outcome-exhaustiveness fix-forward: `af90e770a21ee28bc97b2cead42560092fc6c484`
- Current implementation tree: `509e493238f66e38ed1599a679be0e0525cfee27`
- Worktree: `/private/tmp/codex-tm-d8-operational-observability-20260831`
- Remote exact head: `NOT AVAILABLE`
- Merged-main SHA: `NOT AVAILABLE`

## 2. Local gates

| Gate | Result |
|---|---|
| Observability, metrics, application, restore-worker, server-wiring, and metrics-endpoint tests | 6 files / 46 tests PASS |
| `pnpm --filter @metasheet/core-backend type-check` | PASS |
| Scoped source ESLint | 0 errors; 22 pre-existing `src/index.ts` warnings |
| `git diff --check` | PASS |
| Database/migration | NOT RUN; no DB or migration change |
| Object store / KMS / external I/O | NOT RUN and not constructed by this slice |

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
- Flags OFF leave the factory, database, worker, timer, and observer untouched.

## 5. Evidence levels

| Level | State |
|---|---|
| Source and local focused tests | PASS at product checkpoint |
| Local typecheck/lint/diff | PASS with recorded baseline warnings |
| Independent exact-range model review | Terra high `P1=0 / P2=0 / P3=0` after the bounded exhaustiveness fix-forward |
| Draft PR exact-head CI | NOT RUN |
| Ready / merge | NOT AUTHORIZED by this report |
| Merged-main rerun | NOT RUN |
| D7 staging | NOT RUN / OWNER GATE |
| Flags / dispatch / deployment / production | OFF or NOT RUN / OWNER GATE |
| Real tenant UAT | NOT RUN |

## 6. Residual risk and next gates

This slice does not close production provider/KMS, live archive creation,
retention purge, or staging acceptance. A later operations packet must select
the independent durability domain and key custody, define retention/legal-hold
policy and alert thresholds, execute the D7 runbook, and bind evidence to the
deployed exact SHA. Whole-sheet resurrection remains PARKED and is not a gate
for this D8 candidate.
