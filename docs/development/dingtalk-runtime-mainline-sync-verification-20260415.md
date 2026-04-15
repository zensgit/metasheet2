## Verification

### Passed

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts --reporter=dot
```

- Result: `75/75` tests passed

### Non-blocking Repo Baseline Failure

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

- Still fails on pre-existing non-DingTalk files already on `main`:
  - `src/db/types.ts`
  - `src/multitable/api-token-service.ts`
  - `src/multitable/automation-log-service.ts`
  - `src/multitable/dashboard-service.ts`
  - `src/multitable/webhook-service.ts`
  - `src/routes/dashboard.ts`

## Scope Check

- This sync only resolved `admin-users` route/test conflicts introduced by merging `origin/main` into the DingTalk runtime branch.
- No new type-check regressions were introduced inside the DingTalk runtime files touched in this sync.
