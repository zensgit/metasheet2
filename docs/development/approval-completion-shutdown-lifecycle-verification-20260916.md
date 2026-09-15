# Approval Completion Shutdown Lifecycle Verification

Date: 2026-09-16

## Revision identity

- Main baseline: `784c22dc182b2050bf204f4d013226d5bbb15131`
- Precise-unsubscribe prerequisite (#5758): `f0a7e214c97731c504337847760bc8769bd81a44`
- Verified implementation commit: `2ee83bb86ddd6facf95ffce67b79af9f13f2debb`
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

## Green evidence

Focused lifecycle and precise-unsubscribe suite:

```text
7 test files passed
93 tests passed
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

## Independent bounded review

A read-only independent review was constrained to the eight production files and lifecycle tests. It
found one valid P1: a stale DingTalk boot-time start failure was returned as a shutdown failure even when
no client existed. The implementation was corrected and two opposing tests were added: start-only failure
closes successfully, while a real half-started-client close failure stays failed.

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
