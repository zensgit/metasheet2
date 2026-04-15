# DingTalk Runtime Status Verification

Date: 2026-04-14
Branch: `codex/dingtalk-identity-runtime-20260414`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/dingtalk-oauth-login-gates.test.ts \
  --reporter=dot
```

Result:

- `3` files
- `73` tests
- all passed

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result:

- passed

## Coverage Focus

- login probe returns full runtime status and does not generate OAuth state
- login probe still works when DingTalk is unavailable
- admin DingTalk access snapshot now carries the shared `server` runtime-status block
- runtime helper reports allowlist-driven `corp_not_allowed`

## Verification Notes

- Verification ran in an isolated git worktree for this lane.
- The worktree reused the repository dependency tree via local `node_modules` symlinks so targeted backend commands could resolve workspace packages.
