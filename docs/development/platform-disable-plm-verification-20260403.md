# Platform Disable PLM Verification

## Focused checks

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/featureFlags.plm.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/plm-disable-routes.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc --noEmit
bash -n scripts/ops/multitable-onprem-preflight.sh
bash -n scripts/ops/multitable-onprem-healthcheck.sh
bash -n scripts/ops/attendance-onprem-healthcheck.sh
git diff --check
```

## Results

- `tests/featureFlags.plm.spec.ts`: passed
- `tests/unit/auth-login-routes.test.ts`: passed
- `tests/unit/plm-disable-routes.test.ts`: passed
- backend TypeScript check: passed
- frontend Vue TypeScript check: passed
- multitable/attendance healthcheck shell syntax: passed
- `git diff --check`: passed

## Notes

- The legacy `apps/web/tests/featureFlags.spec.ts` file already contains unrelated historical expectations around anonymous plugin inference; this change set avoids widening that file and uses a focused PLM-specific spec instead.
