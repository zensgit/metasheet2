# Approval Completion Shutdown Lifecycle Design

Date: 2026-09-16

## Bound revisions

- Main baseline: `784c22dc182b2050bf204f4d013226d5bbb15131`
- Required precise-unsubscribe prerequisite (#5758): `f0a7e214c97731c504337847760bc8769bd81a44`
- The implementation branch preserves both revisions as ancestors through an explicit merge commit.

## Problem

Approval completion producers and consumers previously had independent shutdown behavior. The HTTP
server, SLA scheduler, DingTalk callback worker, automation scheduler, projection sweep, and durable
delivery loop could still admit or finish completion-producing work while completion consumers were
being removed or while the PostgreSQL pool was closing. The old global shutdown timeout also left its
timer armed after a successful stop, producing a false timeout warning later.

The completion event census on the bound tree contains seven production calls to
`emitApprovalCompletionEvent` in `ApprovalProductService`: create, admin jump, node timeout, and four
dispatch-action terminal paths.

## Contract

Shutdown follows this order:

1. Synchronously close admissions for HTTP, SLA, DingTalk Stream callbacks, automation event and timer
   producers, projection sweep, and durable delivery.
2. Drain those admitted producers while completion listeners remain attached.
3. Drain the Automation approval-completion bridge to a fixed point while listeners remain attached.
4. Detach only the subscription IDs owned by Automation, approval projection, and record approval.
5. Drain callbacks admitted before detach.
6. Close the PostgreSQL pool only when this approval barrier and the Time Machine recovery worker both
   completed successfully.

A producer, transitive-producer, sink, HTTP, or recovery-worker failure or timeout is fail-closed: use
values-free reason codes, reject shutdown, and leave the PostgreSQL pool open. Repeated stop calls share
one promise. Producer-drain promises are observed in the same synchronous stack in which they are created,
before any unrelated worker drain can delay the shared barrier; the original rejection is retained for the
later barrier verdict. A partial startup uses the same idempotent cleanup path.

## Local ownership

- EventBus remains synchronous and unchanged. There is no global emit-await mechanism.
- Each completion consumer tracks its own IDs and in-flight promises.
- Automation separates admission producers, transitive completion producers, and terminal consumers.
- Standalone `AutomationService.shutdown()` drains producers before detaching completion consumers;
  partial-startup rollback uses that path, while normal server shutdown coordinates the same phases
  across all completion producers and consumers.
- Timer schedulers latch stop synchronously and await their currently admitted callback.
- The DingTalk worker distinguishes a stale start failure from a real client-stop failure.
- The bounded shutdown helper always clears its timer on success; a real timeout rejects.

## Non-goals

- No DDL or database execution.
- No SDK, shared workflow, EventBus dispatch, durable-delivery semantic, feature-flag, or default behavior
  change.
- No deployment, flag enablement, Ready transition, or merge authorization.
- HTTP drain timeout remains fail-closed; this slice does not redesign WebSocket or long-poll teardown.
- The process-wide SLA singleton model is unchanged.

## Required evidence

- Focused lifecycle tests for delayed producers, delayed sinks, transitive fixed-point work, partial
  subscriptions, precise sibling survival, callback admission, scheduler ticks, partial startup, and
  repeated stop behavior.
- Failure tests proving zero `pool.end()` calls.
- A mutation that detaches a listener before producer drain must make the ordering suite fail, followed
  by a green rerun after restoration.
- Neighbor scheduler, DingTalk SDK, Automation V1, server lifecycle, and Time Machine recovery wiring
  tests.
- Core-backend TypeScript typecheck and `git diff --check`.

## Gate

This slice remains Draft/HOLD. Passing tests establish the bounded lifecycle contract only; they do not
authorize merge, deployment, database work, or flag changes.
