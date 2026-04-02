# Attendance Payroll Generate Contract Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "accepts payroll cycle generate year/month aliases and reports missing anchors clearly" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Results

- `git diff --check` passed
- focused integration passed: `1 passed | 57 skipped`
- backend typecheck passed
- OpenAPI generation succeeded and refreshed `packages/openapi/dist/*`
