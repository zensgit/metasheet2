# Run 5 Approvals And Nav Hotfix Verification

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approvals-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/usePlugins.spec.ts tests/platform-shell-nav.spec.ts tests/approval-inbox-auth-guard.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Expected outcomes

- `req.user.id` is sufficient for `/api/approvals/pending` and approval actions.
- The shell nav no longer exposes `/p/plugin-attendance/attendance`.
- Legacy direct visits to `/p/plugin-attendance/attendance` redirect to `/attendance`.
- Existing approval inbox unauthorized handling still suppresses global logout redirects.
