# Approval SLA Leader Lock Development - 2026-04-25

## Context

The approval SLA scheduler introduced periodic breach scanning, but every API replica could run the scan. The SQL path is idempotent, yet duplicate scans still add avoidable database pressure and make operational attribution noisy.

This slice adds an opt-in Redis-backed leader lock for the SLA scheduler while keeping legacy single-process behavior as the default.

## Changes

- Extended `ApprovalSlaScheduler` with optional `leaderOptions`.
- Added Redis lock acquisition, renewal, and release around scheduler startup/shutdown.
- Added a `leader` getter and a follower guard so non-leaders return without scanning.
- Added `resolveApprovalSlaSchedulerLeaderOptions()` to construct the Redis-backed lock from environment flags.
- Wired `MetaSheetServer.start()` to pass resolved leader options into `startApprovalSlaScheduler()`.
- Documented environment flags in `.env.example` and `packages/core-backend/.env.development.example`.
- Added unit coverage for leader/follower behavior and lock release takeover.

## Configuration

```bash
ENABLE_APPROVAL_SLA_LEADER_LOCK=true
APPROVAL_SLA_LEADER_LOCK_TTL_MS=30000
```

The feature remains disabled unless `ENABLE_APPROVAL_SLA_LEADER_LOCK=true`.

## Design Notes

- Default behavior is unchanged. Without `leaderOptions`, the scheduler acts as leader immediately.
- When the flag is enabled but Redis is unavailable, `resolveApprovalSlaSchedulerLeaderOptions()` returns `null`, preserving legacy behavior rather than blocking startup.
- The lock owner is process-scoped: `approval-sla:<pid>:<random>`.
- Renewal runs at half of the TTL with a minimum interval of 1000 ms.
- If renewal fails, the scheduler relinquishes leadership and stops further scans.

## Explicit Limitations

- Follower processes do not currently run a background takeover loop after a failed initial election. A restart or future retry enhancement is needed for automatic follower promotion.
- Redis outage with the flag enabled degrades to legacy all-replica scheduling instead of fail-closed single-leader mode.
- No Prometheus leader gauge was added in this slice.

## Files

- `.env.example`
- `packages/core-backend/.env.development.example`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/services/ApprovalSlaScheduler.ts`
- `packages/core-backend/tests/unit/approval-sla-scheduler.test.ts`
