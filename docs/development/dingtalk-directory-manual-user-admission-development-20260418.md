# DingTalk Directory Manual User Admission Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Allow an operator to create a local platform user directly from a synced DingTalk directory member and bind that new user in one review-card action.

## Problem

The earlier review-card prototype handled manual admission entirely in the frontend:

1. `POST /api/admin/users`
2. optional `PATCH /api/admin/users/:userId/profile`
3. `POST /api/admin/directory/accounts/batch-bind`

That worked, but it had two real weaknesses:

- partial-success states were owned by the browser instead of the backend;
- audit and onboarding outputs were split across three routes.

At the same time, operators still needed a safe way to admit synced DingTalk members who do not yet have local accounts.

## Implementation

### Backend

Files:

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`

Changes:

- Added `admitDirectoryAccountUser(directoryAccountId, input)` to `directory-sync.ts`.
- Added `POST /api/admin/directory/accounts/:accountId/admit-user`.
- The new server-side flow now does the whole admission in one backend operation:
  1. validate directory account and DingTalk identifiers;
  2. sanitize `name`, `email`, and `mobile`;
  3. generate or validate a temporary password;
  4. create the local `users` row;
  5. bind DingTalk identity / grant / `directory_account_links` in the same service path;
  6. issue invite token and onboarding packet;
  7. return the freshly linked directory account summary plus onboarding outputs.
- Route-level audit logging now records:
  - user creation
  - manual directory bind

### Frontend

Files:

- `apps/web/src/views/DirectoryManagementView.vue`

Changes:

- Kept the review-card manual admission UI:
  - `手动创建用户`
  - `创建用户并绑定`
- Switched the submit path from three client-side API calls to one backend route:
  - `POST /api/admin/directory/accounts/:accountId/admit-user`
- Preserved the review-card UX:
  - prefill `name/email/mobile` from synced DingTalk member
  - result panel with temporary password and invite link
  - refresh review/accounts after success
- Updated sample placeholder data to avoid using the prior real-looking phone example.

## Current Scope

This round established the server-side admission primitive that later rounds now reuse for:

- manual admission from review cards;
- scoped automatic admission for allowlisted departments;
- temporary-password onboarding with forced password change.

It still does **not** yet implement:

- local department projection into groups;
- excluded department rules;
- scheduled password rotation policies.
