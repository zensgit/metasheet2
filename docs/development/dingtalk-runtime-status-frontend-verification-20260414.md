# DingTalk Runtime Status Frontend Verification

Date: 2026-04-14
Branch: `codex/dingtalk-identity-frontend-20260414`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/LoginView.spec.ts \
  tests/userManagementView.spec.ts \
  --watch=false --reporter=dot
```

Result:

- `2` files
- `5` tests
- all passed

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result:

- passed

## Coverage Focus

- login page reads structured probe status instead of only `response.ok`
- login page hides DingTalk entry when server reports unavailable and shows a reason hint
- user management page renders the new `server` runtime-status block from `/api/admin/users/:userId/dingtalk-access`
