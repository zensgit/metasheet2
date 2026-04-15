# DingTalk Identity Review Runbook

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## Purpose

Provide one compact review/merge runbook for the three DingTalk identity lanes.

## PR Links

### Runtime

- Branch: `codex/dingtalk-identity-runtime-20260414`
- PR: <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-runtime-20260414>
- Head: `80864ac61`

### Frontend

- Branch: `codex/dingtalk-identity-frontend-20260414`
- PR: <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-frontend-20260414>
- Head: `7060a2f30`

### Integration / Docs

- Branch: `codex/dingtalk-identity-integration-20260414`
- PR: <https://github.com/zensgit/metasheet2/pull/new/codex/dingtalk-identity-integration-20260414>
- Current docs head: `3d4d68cda` before this runbook

## Merge Order

1. runtime
2. frontend
3. integration/docs

## Review Focus

### Runtime review

- `GET /api/auth/dingtalk/launch?probe=1` now returns structured runtime status
- `/api/admin/users/:userId/dingtalk-access` now includes `server`
- launch/callback success semantics remain unchanged

### Frontend review

- login page only shows DingTalk entry when runtime probe reports `available === true`
- login page shows a reason hint for unavailable probe states
- user management page shows server runtime status, corpId, and allowlist context

### Integration/docs review

- stack verification exists
- handoff docs exist
- PR draft/package/final-copy docs exist
- merge checklist exists

## Post-Merge Smoke

After runtime + frontend merge to `main`, run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/dingtalk-oauth-login-gates.test.ts \
  --reporter=dot
```

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/LoginView.spec.ts \
  tests/userManagementView.spec.ts \
  --watch=false --reporter=dot
```

Manual checks:

1. login page when DingTalk probe is available
2. login page when allowlist blocks DingTalk
3. admin user page shows server status, corpId, allowlist, grant, identity

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
- `dingtalk-identity-pr-package-development-20260414.md`
- `dingtalk-identity-pr-package-verification-20260414.md`
- `dingtalk-identity-pr-final-copy-development-20260414.md`
- `dingtalk-identity-pr-final-copy-verification-20260414.md`
- `dingtalk-identity-merge-checklist-development-20260414.md`
- `dingtalk-identity-merge-checklist-verification-20260414.md`
