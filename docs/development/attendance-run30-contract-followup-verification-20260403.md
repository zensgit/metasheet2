# Attendance Run 30 Contract Follow-up Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "accepts compatibility payload aliases for rotation rule and payroll cycle routes" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Expected Assertions

- rotation rule create accepts `shift_ids` compatibility payloads
- payroll cycle create accepts `payrollTemplateId` and `anchor_date`
- payroll cycle generate accepts `payrollTemplateId` and `name_prefix`
- generated OpenAPI includes concrete examples for manual testing
- quickstart doc gives a reproducible manual sequence for validating shift delete `409`
