# Platform Shell Wave 1 Metrics CI Unblock Verification

## Scope

Verify that the CI-blocking metrics integration assertion is fixed without
changing runtime metrics behavior.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run src/metrics/__tests__/metrics-integration.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/platform-apps-router.test.ts tests/unit/after-sales-plugin-routes.test.ts tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/core-backend build
```

## Expected Result

- metrics integration test passes on current exports
- platform-shell backend regressions still pass
- backend build succeeds

## Notes

This fix addresses a failing assertion on current `main`, not a platform-shell
runtime regression.

