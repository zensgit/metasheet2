# Attendance Request Contract Follow-up Verification

## Commands

- `git diff --check`
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "accepts snake_case attendance request aliases and returns validation details for malformed request payloads|accepts compatibility payload aliases for rotation rule and payroll cycle routes" --reporter=dot`
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
- `pnpm exec tsx packages/openapi/tools/build.ts`

## Expected

- Snake_case attendance request payloads create successfully.
- Invalid attendance request payloads return `400` with `error.code=VALIDATION_ERROR` and non-empty `error.details`.
- OpenAPI build succeeds with updated request aliases and examples.
