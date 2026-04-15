# DingTalk Identity PR Final Copy

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## Runtime PR

Branch:

- `codex/dingtalk-identity-runtime-20260414`

Base:

- `main`

Title:

```text
feat(dingtalk): add runtime status probes
```

```md
## What Changed

- added a shared DingTalk runtime status helper in backend auth/runtime code
- enriched `GET /api/auth/dingtalk/launch?probe=1` to return structured runtime status
- enriched `/api/admin/users/:userId/dingtalk-access` with a `server` runtime-status block

## Why

Login and admin pages need one stable backend view of DingTalk availability, allowlist policy, and auth-mode flags without reopening the callback flow.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts --reporter=dot`
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false`

## Notes

- launch and callback success behavior remain unchanged
- backend/runtime only
```

## Frontend PR

Branch:

- `codex/dingtalk-identity-frontend-20260414`

Base:

- `codex/dingtalk-identity-runtime-20260414`
  or `main` after the runtime PR merges

Title:

```text
feat(dingtalk): surface runtime status in frontend
```

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

## Integration PR

Branch:

- `codex/dingtalk-identity-integration-20260414`

Base:

- `main`

Title:

```text
docs: add dingtalk identity stack handoff
```

```md
## What Changed

- added combined DingTalk identity verification summary
- added handoff and merge-order notes
- added GitHub-ready PR drafts, PR package copy, and merge checklists

## Why

The DingTalk identity work was intentionally split across runtime, frontend, and integration lanes. This PR keeps the handoff material explicit and reviewable.

## Verification

- verified referenced runtime lane commit and docs
- verified referenced frontend lane commit and docs
- confirmed merge order and worktree isolation notes

## Notes

- docs-only
- merge after runtime + frontend
```
