# Gate E caller rollback proof supplement — 2026-10-26

Status: derived test-only proof, Draft/HOLD. Frozen base main: 40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b. This is not W8 adoption, an ownership-contract amendment or runtime behavior change.

## Authority and exact gap

The existing Gate E / issue #4844 contract, cited by the batch-1 real-DB suite and W8 ledger L13, requires refusal on caller-owned transactions, typed refusal on idle-probe cleanup failure, and preservation of caller ownership. The existing 4b cases intentionally reject both probe teardown statements, prove that caller RELEASE succeeds, and only then roll back. They prove an unreleased probe existed before RELEASE and that the connection is reusable; they do not isolate ROLLBACK itself as the cause removing a still-defined probe. Current runtime is not shown defective by this gap.

## Two named cases

Add exactly one 4c case for each existing boundary:
- runAttendanceResultOperationTransactionV1.
- dispatchAttendanceResultEventOutboxV1.

Each case starts an explicit caller transaction and inserts a namespaced synthetic probe row. The existing teardown-failure wrapper rejects only the two probe teardown statements before PostgreSQL sees them. Require the exact product refusal, zero business callback/event invocation, second-connection invisibility and caller visibility. A real caller ROLLBACK TO SAVEPOINT must succeed twice; this retains rather than releases the savepoint. With no caller RELEASE, full caller ROLLBACK must erase the uncommitted row. A new transaction must then reject RELEASE of that old probe with 3B001, show the corresponding failed-transaction state, and recover through a final caller ROLLBACK.

This is a proof of caller recovery after a simulated cleanup failure. It does not promise that callee cleanup can always succeed, permit a callee to roll back another owner's transaction, or close owner acceptance of that boundary.

## Gates and limits

- Original ten test bodies/assertions, namespace, setup, wrappers, config and budgets remain behaviorally unchanged. Correct only the misleading 4b title/comment explanation.
- Execute only the two new 4c cases; original ten green cases remain filtered exclusions, never counted as passed.
- Use the existing owned stopped UTF8 PostgreSQL cluster and previously migrated isolated synthetic database only after real PID/port checks; compare migration source/ledger rather than repeat passed migration or old suites. Restore stopped posture and retain data. The suite owns only its namespaced scratch table.
- Mutation: let the callee consume the caller transaction after failed teardown. Each new case must turn red on loss of the caller's row; restore exact source bytes. No mutation is committed.
- Explicit changed-test lint, source/registration applicability audit, independent review and exact source manifest. Existing quality may be carried only by verified unchanged validated inputs; report any fresh command separately. New published-head CI must be checked independently and terminal success is required for final CI evidence.
- Do not broaden the strict corpus, change runtime/parser/SQL budgets, alter existing test retry/timeout, touch the canonical checkout, or create a new capability.
- All PRs Draft/HOLD. No merge, deployment, R71/tag/release, business config or flag change. Stream/lifecycle OFF. Real UAT and business50004 excluded; historical08PUT remains INCONCLUSIVE. Owner/PQA/soak/human/live acceptance remains separate.
