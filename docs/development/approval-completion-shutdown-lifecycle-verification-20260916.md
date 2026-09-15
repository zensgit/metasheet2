# Approval Completion Shutdown Lifecycle Verification

Date: 2026-09-16

## Revision identity

- Main baseline: `784c22dc182b2050bf204f4d013226d5bbb15131`
- Precise-unsubscribe prerequisite (#5758): `f0a7e214c97731c504337847760bc8769bd81a44`
- Verified implementation commit: `b93877da982c5d1b73cc15f6e5e232f1bd1c5344`
- Startup-matrix harness follow-up: `a03db65f7329e819b532a4ff6c0a3714dc38d979`
- The implementation commit has both the main baseline and prerequisite as ancestors.
- This verification file is a documentation-only successor to the implementation commit.

## Scope audit

Production changes are limited to the eight files authorized by the design:

1. `packages/core-backend/src/index.ts`
2. `packages/core-backend/src/integrations/dingtalk/interactive-card-stream.ts`
3. `packages/core-backend/src/multitable/approval-record-projection-service.ts`
4. `packages/core-backend/src/multitable/automation-scheduler.ts`
5. `packages/core-backend/src/multitable/automation-service.ts`
6. `packages/core-backend/src/multitable/record-approval-submission-service.ts`
7. `packages/core-backend/src/services/ApprovalProjectionSweepScheduler.ts`
8. `packages/core-backend/src/services/ApprovalSlaScheduler.ts`

No DDL, migration, database execution, SDK, EventBus dispatch, shared workflow, feature-flag default,
deployment, or runtime-enable change was made.

The bound `ApprovalProductService` tree contains exactly seven calls to
`emitApprovalCompletionEvent`, at the create, admin-jump, node-timeout, and four dispatch-action
terminal paths.

## Red-first evidence

Before production implementation, the focused lifecycle command produced 68 passing and 9 failing
tests. The failures were the missing lifecycle handles, delayed scheduler/callback drains, partial
subscription rollback, and early DingTalk shutdown behavior introduced by the new tests.

The exact-head follow-up test delayed the recovery-worker drain while making a producer drain reject
immediately. Before the follow-up fix, the lifecycle file produced 1 failed and 6 passed tests plus one
Vitest unhandled-rejection error (`producer sentinel`). This confirmed that the shared barrier observed
the rejection too late.

## Green evidence

Focused lifecycle and precise-unsubscribe suite:

```text
7 test files passed
94 tests passed
0 failed
```

Covered behavior includes:

- Delayed producer work keeps all completion listeners attached.
- Active HTTP request drain completes before detach.
- Automation bridge drain reaches a fixed point when a second completion task is added while draining.
- Automation, projection, and record listeners detach only their own EventBus IDs; a same-event sibling
  remains live.
- SLA, projection sweep, Automation timer, and DingTalk callback admissions close synchronously and
  their admitted work drains.
- Producer failure and DingTalk client-stop failure produce zero `pool.end()` calls.
- An immediately rejected producer drain is observed before an unrelated recovery-worker drain finishes;
  the final barrier still rejects and the pool remains open.
- A stale DingTalk start failure is not misclassified as a stop failure; a real half-started-client close
  failure remains fail-closed.
- Partial startup invokes the same idempotent stop promise.
- A successful bounded wait clears its timer; a real timeout rejects with a values-free code.

Neighbor suites:

```text
server lifecycle, Time Machine recovery wiring, Automation scheduler leader/date/metrics,
and DingTalk worker/SDK: 7 files, 53 tests passed
Automation V1: 1 file, 292 tests passed
core-backend TypeScript typecheck: passed
git diff --check: passed
```

The follow-up exact-head rerun also passed the server lifecycle and Time Machine recovery wiring
neighbors (2 files, 9 tests). The broader neighbor and Automation V1 results above remain evidence from
the preceding implementation commit; they were not rerun for the three-file follow-up.

The first CI run at documentation head `b171cc34b302ff8ed5ddd96061eb2faa09094bfd`
found two direct compatibility regressions in the Node 20 core-backend lane: the real-app assembly census
still pinned startup-owned `this.app` sites to `start`, while the implementation had moved that body to
`startOnce` for rollback; and standalone `AutomationService.shutdown()` no longer detached all nine
subscriptions before its first asynchronous yield. The lane reported 3 failed tests in 2 files, with
13,833 passed. The census pins were updated to the actual owner, and standalone shutdown now starts the
producer drain and synchronously detaches completion consumers before awaiting it. The server continues
to use the phased API, so its producer-before-consumer ordering is unchanged.

The two affected files then passed locally (2 files, 161 tests), followed by the focused lifecycle suite
(7 files, 94 tests), TypeScript typecheck, and `git diff --check`.

The next CI run at documentation head `5a9493285b243f155a2096c90e223473414b440a`
passed the complete core-backend step in both Node lanes, then exposed one later Node 18 real-DB harness
failure: the startup fail-closed matrix still assumed rejected starts never invoked `stop()`. Its first
failure row now correctly ran the shared cleanup path and ended the process-global pool, so a later healthy
row failed against that already-ended pool (1 failed, 1,783 passed in the integration step). The test-only
harness follow-up spies `pool.end()` to a no-op for this multi-server matrix and restores it after all
successful servers are stopped; every other worker, producer, listener, and scheduler rollback remains real.

No local database was configured. The corrected integration file was collected with its integration config
and all 8 database-gated tests skipped; that is collection evidence only, not a passing DB run. TypeScript
typecheck and `git diff --check` passed. A current-head CI run remains required for database-backed proof.

The existing server-lifecycle neighbor attempted its normal default database connection and entered its
existing degraded path because no test database was configured. No migration, database write, or real-DB
acceptance was run, and this result is not represented as database evidence.

## Mutation evidence

Mutation: insert `recordApprovalCompletionSubscription.detach()` immediately after producer-stop
admission and before the producer barrier.

Result:

```text
approval-completion-shutdown-lifecycle.test.ts: 4 failed, 2 passed
```

The failures were the producer-delay, producer-failure, active-HTTP, and DingTalk-close-failure ordering
assertions. The mutation was removed with a targeted patch; the same file then passed 6/6, followed by
the final 93/93 focused run. This proves the tests depend on listeners remaining attached until the
producer barrier succeeds.

Follow-up mutation: remove the immediate observation wrapper from the durable-delivery producer drain
while leaving the later shared barrier intact.

Result:

```text
approval-completion-shutdown-lifecycle.test.ts: 1 failed, 6 passed, 1 unhandled rejection
```

The mutation reproduced the delayed-handler failure and was removed with a targeted patch. The lifecycle
file then passed 7/7 and the final focused run passed 94/94. The catch handler observes the original
promise in the creation stack but does not replace it, so the later barrier still receives the rejection
and returns `APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED` with zero `pool.end()` calls.

## Independent bounded review

A read-only independent review was constrained to the eight production files and lifecycle tests. It
found one valid P1: a stale DingTalk boot-time start failure was returned as a shutdown failure even when
no client existed. The implementation was corrected and two opposing tests were added: start-only failure
closes successfully, while a real half-started-client close failure stays failed.

A subsequent exact-head read-only review found the immediate producer-rejection P2 described above. The
bounded follow-up changed only the server barrier, its dedicated test, and this design/verification pair.

Two suggestions were not adopted:

- An HTTP/long-poll timeout remains fail-closed by the explicit contract; redesigning shared Socket.IO
  teardown is outside this slice.
- The process-wide SLA singleton predates this change and multi-server ownership is outside the supported
  production model; no singleton redesign was authorized.

## Residual boundary

- No real database, deployment, signal-driven process, WebSocket/long-poll, or production runtime test was
  performed.
- A real 10-second timeout intentionally leaves the pool open and causes signal shutdown to exit nonzero.
- The PR must remain Draft/HOLD. Green tests are not merge, deployment, flag, or database authorization.
