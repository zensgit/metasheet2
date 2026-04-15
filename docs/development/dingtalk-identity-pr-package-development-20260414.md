# DingTalk Identity PR Package

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## Purpose

Package the DingTalk identity work into three reviewable PRs with copy-ready GitHub content.

## PR 1

Branch:

- `codex/dingtalk-identity-runtime-20260414`

Base:

- `main`

Title:

```text
feat(dingtalk): add runtime status probes
```

Short body:

```md
## What Changed

- added a shared DingTalk runtime status helper in backend auth/runtime code
- enriched `GET /api/auth/dingtalk/launch?probe=1` to return structured runtime status
- enriched `/api/admin/users/:userId/dingtalk-access` with a shared `server` runtime-status block

## Why

Login and admin pages need one stable backend view of DingTalk availability, allowlist policy, and auth-mode flags without reopening the callback flow.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts --reporter=dot`
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false`

## Notes

- normal launch/callback success behavior is unchanged
- backend/runtime only
```

## PR 2

Branch:

- `codex/dingtalk-identity-frontend-20260414`

Base:

- `codex/dingtalk-identity-runtime-20260414`
  or `main` after PR 1 merges

Title:

```text
feat(dingtalk): surface runtime status in frontend
```

Short body:

```md
## What Changed

- login page now consumes the structured DingTalk probe payload
- user management page now surfaces backend runtime status, corpId, and allowlist context

## Why

Frontend should distinguish server unavailability from per-user grant and identity state instead of treating DingTalk availability as a simple boolean.

## Verification

- `pnpm --filter @metasheet/web exec vitest run tests/LoginView.spec.ts tests/userManagementView.spec.ts --watch=false --reporter=dot`
- `pnpm --filter @metasheet/web exec tsc --noEmit --pretty false`

## Notes

- frontend consumption only
- no callback-flow protocol changes
```

## PR 3

Branch:

- `codex/dingtalk-identity-integration-20260414`

Base:

- `main`

Title:

```text
docs: add dingtalk identity stack handoff
```

Short body:

```md
## What Changed

- added combined DingTalk identity verification summary
- added handoff and merge-order notes
- added GitHub-ready PR drafts and review checklists

## Why

The DingTalk identity work was intentionally split across runtime, frontend, and integration lanes. This PR keeps the handoff material explicit and reviewable.

## Verification

- verified referenced runtime lane commit and docs
- verified referenced frontend lane commit and docs
- confirmed merge order and worktree isolation notes
```

## Recommended Merge Order

1. PR 1 runtime
2. PR 2 frontend
3. PR 3 integration/docs

## Supporting Docs

- `dingtalk-runtime-status-development-20260414.md`
- `dingtalk-runtime-status-verification-20260414.md`
- `dingtalk-runtime-status-frontend-development-20260414.md`
- `dingtalk-runtime-status-frontend-verification-20260414.md`
- `dingtalk-identity-stack-verification-20260414.md`
- `dingtalk-identity-stack-handoff-development-20260414.md`
- `dingtalk-identity-stack-handoff-verification-20260414.md`
- `dingtalk-identity-pr-drafts-development-20260414.md`
- `dingtalk-identity-pr-drafts-verification-20260414.md`
