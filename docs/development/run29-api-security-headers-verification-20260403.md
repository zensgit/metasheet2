# Run29 API Security Headers Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/server-lifecycle.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Expected Result

- lifecycle test starts `MetaSheetServer`
- `GET /api/plugins` returns `200`
- `x-content-type-options` response header equals `nosniff`
- TypeScript build stays clean

## Notes

Attendance `400 vs 404` semantics were re-verified in existing plugin handlers and integration coverage. No behavior change was made in this slice.
