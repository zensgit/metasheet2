# Attendance Shift Delete Guard Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "returns 409 when deleting a shift that is still referenced by an active assignment|returns 409 when deleting a shift that is still referenced by an active rotation assignment" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Expected Result

- deleting a shift with an active direct assignment returns `409`
- deleting a shift with an active rotation assignment returns `409`
- follow-up shift lookup still returns `200`
- TypeScript and OpenAPI generation remain clean

## Notes

This slice intentionally does not block deletion for purely historical or inactive references.
