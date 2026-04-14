# DingTalk Identity Merge Checklist Verification

Date: 2026-04-14
Branch: `codex/dingtalk-identity-integration-20260414`

## Reviewed Inputs

- `dingtalk-runtime-status-verification-20260414.md`
- `dingtalk-runtime-status-frontend-verification-20260414.md`
- `dingtalk-identity-stack-verification-20260414.md`
- `dingtalk-identity-stack-handoff-development-20260414.md`
- `dingtalk-identity-stack-handoff-verification-20260414.md`
- `dingtalk-identity-pr-drafts-development-20260414.md`
- `dingtalk-identity-pr-drafts-verification-20260414.md`
- `dingtalk-identity-pr-package-development-20260414.md`
- `dingtalk-identity-pr-package-verification-20260414.md`

## Confirmed Branch Heads

- runtime: `80864ac61`
- frontend: `7060a2f30`
- integration/docs current head before this doc: `bbfcdaa0e`

## Confirmed Verification Baseline

### Runtime

- `73/73`
- backend `tsc` passed

### Frontend

- `5/5`
- frontend `tsc` passed

## Claude Code CLI Status

Checked in this turn:

- `claude auth status` succeeded
- `claude -p "Return exactly: CLAUDE_CLI_OK"` succeeded

Conclusion:

- Claude Code CLI is callable right now
- suitable use remains: isolated worktree, narrow backend/docs/integration tasks
- avoid relying on it for long mixed-scope editing runs when deterministic delivery matters

## Post-Merge Smoke Recommendation

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

Then manually verify:

1. login page with `probe=1` available state
2. login page with allowlist-blocked state
3. user management DingTalk panel shows server status, corpId, allowlist, grant, identity
