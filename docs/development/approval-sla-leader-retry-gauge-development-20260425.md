# Approval SLA Leader Retry and Gauge Development - 2026-04-25

## Context

The first SLA leader-lock slice made the scheduler single-leader when Redis is enabled, but it intentionally left two operational gaps:

- Followers did not attempt takeover after losing the initial election.
- No Prometheus gauge exposed the current SLA scheduler leader state.

This slice closes both gaps while preserving the existing opt-in behavior.

## Changes

- Added `retryIntervalMs` to `ApprovalSlaSchedulerLeaderOptions`.
- Added follower retry loop that periodically re-attempts lock acquisition while the scheduler is started.
- Restarted retry after renewal loss so a relinquished node can recover after the lock becomes available again.
- Added injected `ApprovalSlaSchedulerLeaderGauge` runtime option.
- Added `approval_sla_scheduler_leader{state="leader|follower|relinquished"}` Prometheus gauge.
- Wired `MetaSheetServer.start()` to pass the shared metrics gauge into `startApprovalSlaScheduler()`.
- Added `APPROVAL_SLA_LEADER_LOCK_RETRY_MS` to environment templates.

## Design Notes

- The feature remains behind `ENABLE_APPROVAL_SLA_LEADER_LOCK=true`.
- Retry runs only after `start()`; constructing a scheduler no longer implies permanent background takeover attempts.
- A successful retry stops the acquisition loop, starts renewal, and starts the normal SLA tick interval if the scheduler is still started.
- Gauge writes are best-effort and cannot break scheduler behavior.
- The gauge mirrors the existing automation scheduler shape so operators can use the same alerting pattern.

## Configuration

```bash
ENABLE_APPROVAL_SLA_LEADER_LOCK=true
APPROVAL_SLA_LEADER_LOCK_TTL_MS=30000
APPROVAL_SLA_LEADER_LOCK_RETRY_MS=10000
```

## Explicit Non-Goals

- No live Redis integration test in this slice.
- No fail-closed behavior when Redis is unavailable; existing legacy fallback remains unchanged.
- No changes to SLA breach SQL or notification/audit hooks.

## Files

- `.env.example`
- `packages/core-backend/.env.development.example`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/metrics/metrics.ts`
- `packages/core-backend/src/services/ApprovalSlaScheduler.ts`
- `packages/core-backend/tests/unit/approval-sla-scheduler.test.ts`
