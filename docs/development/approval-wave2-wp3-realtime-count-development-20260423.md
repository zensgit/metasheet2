# Approval Wave 2 WP3 slice 3 — realtime pending count development

Date: 2026-04-23
Branch: `codex/approval-wave2-wp3-realtime-count-20260423`
Base: `origin/main@6a677f9c3`

## Scope

This slice adds realtime delivery for approval pending/unread counts while
keeping the existing REST refresh path intact.

Events that now trigger count refresh pushes:

- `mark-read`
- `mark-all-read`
- `remind`
- approval action/state paths that can change pending assignments

## Backend Design

`packages/core-backend/src/services/approval-realtime.ts` centralizes count
payload construction:

- computes `count` and `unreadCount`
- includes snapshots for `all`, `platform`, and `plm`
- publishes `approval:counts-updated`
- suppresses publish failures so approval writes remain authoritative

The route layer calls the publisher only after the relevant DB operation
succeeds.

## Authenticated Socket Room

Approval counts are user-specific. The implementation intentionally does not
publish to the legacy naked `query.userId` room.

`CollabService` now also supports an authenticated user room:

- frontend sends JWT via `handshake.auth.token`
- backend verifies the token with a lazy `authService.verifyToken` import
- socket joins `auth-user:<userId>`
- approval realtime publisher emits only to that authenticated room

This preserves existing legacy socket behavior for other consumers while
protecting approval count updates from forged `query.userId` subscriptions.
The auth service import is intentionally lazy because `AuthService` pulls in
RBAC/metrics modules; importing it at `CollabService` module load time can
double-register global Prometheus metrics during parallel test collection.

## Frontend Design

`apps/web/src/approvals/useApprovalCountsRealtime.ts` owns the socket lifecycle.

`ApprovalCenterView` continues to fetch counts through REST on mount, tab
changes, source-system changes, and bulk read actions. Realtime pushes only
update the badge state; socket failures do not surface to the user.

## Files

- `packages/core-backend/src/services/approval-realtime.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/tests/unit/approval-realtime.test.ts`
- `packages/core-backend/tests/unit/approvals-routes.test.ts`
- `packages/core-backend/tests/unit/approvals-bridge-routes.test.ts`
- `apps/web/src/approvals/useApprovalCountsRealtime.ts`
- `apps/web/src/views/approval/ApprovalCenterView.vue`
- `apps/web/tests/approvalCountsRealtime.spec.ts`
- `docs/development/approval-wave2-wp3-realtime-count-development-20260423.md`
- `docs/development/wp3-realtime-count-verification.md`

## Non-goals

- No Redis/socket clustering changes.
- No realtime delivery guarantee or replay queue. REST remains the recovery
  path.
- No complex role-recipient expansion beyond the count computation query.
