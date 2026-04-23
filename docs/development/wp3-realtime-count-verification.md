# Approval Wave 2 WP3 slice 3 — realtime approval count verification

Date: 2026-04-23
Branch: `codex/approval-wave2-wp3-realtime-count-20260423`
Base: `origin/main@6a677f9c3`

Approval Wave 2 WP3 slice 3 adds Socket.IO delivery for approval pending/unread badge updates.

## Backend contract

- Event: `approval:counts-updated`
- Target: current user's authenticated Socket.IO room
  (`auth-user:<userId>`). The frontend sends the JWT in `handshake.auth.token`;
  `CollabService` verifies it before joining the authenticated room. This avoids
  using the legacy naked `handshake.query.userId` room for approval count data.
- Payload:
  - `count` / `unreadCount` for `sourceSystem=all`
  - `countsBySourceSystem.all|platform|plm` for filtered approval center tabs
  - `reason` such as `mark-read`, `mark-all-read`, `remind`, or `action:approve`

The router publishes after successful `mark-read`, `mark-all-read`, `remind`, and approval action/state paths. Remind also clears read rows for active direct user assignees, so a nudge reappears as unread for those users.

## Frontend behavior

`ApprovalCenterView` keeps the existing REST refresh path on mount, tab changes, and after bulk mark-read. The realtime composable only updates the badge from pushed counts; socket connection failures do not surface to the user or block REST.

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-realtime.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-realtime.test.ts tests/unit/approvals-routes.test.ts tests/unit/approvals-bridge-routes.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/approvalCountsRealtime.spec.ts tests/approvalCenterUnreadBadge.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

## Results

- `approval-realtime.test.ts`: `3/3` passed.
- Backend realtime + legacy action route regression: `36/36` passed.
- Backend `tsc --noEmit`: exit `0`.
- Backend full `vitest run --reporter=dot`: `2535/2535` passed, `45` skipped.
- `approvalCountsRealtime.spec.ts`: `1/1` passed.
- `approvalCenterUnreadBadge.spec.ts`: `7/7` passed.
- Frontend `vue-tsc -b --noEmit`: exit `0`.

Expected test noise:

- `approvalCenterUnreadBadge.spec.ts` intentionally logs one rejected
  `mark-read` request to prove the detail view does not surface an error toast.
- Full backend run logs expected local PostgreSQL `database "chouhua" does not
  exist` errors from degraded server lifecycle paths; the suite still exits `0`.

## CI Hardening Fix

PR CI initially failed in Node 18 full backend tests because a top-level
`authService` import from `CollabService` pulled in RBAC metrics during parallel
test collection and attempted to register `http_server_requests_seconds` twice.
The fix keeps token verification lazy at socket join time.

The same full run also exposed missing fake DB coverage in legacy approval route
tests for the new direct-assignee lookup. The route fakes now return active
direct assignees for `SELECT DISTINCT assignee_id FROM approval_assignments`,
and the legacy unit fixture defaults `pool.query` to an empty result.

Manual smoke:

1. Open `/approvals` as an assignee and confirm the pending badge loads from REST.
2. Open another session as the requester, click `催办`, and confirm the assignee session receives a badge update without refresh.
3. Open an approval detail as the assignee and confirm `mark-read` drops the unread badge in the approval center session.
4. Disconnect the socket in devtools and confirm tab switches still refresh badge counts via REST.
