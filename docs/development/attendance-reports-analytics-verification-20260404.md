# Attendance Reports Analytics Verification

Date: 2026-04-04

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendance-reports-analytics.spec.ts tests/attendance-experience-entrypoints.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/attendance-surface-modes.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Result

All commands passed.

## Verified behavior

1. Reports mode renders a dedicated analytics snapshot card.
2. Reports mode exposes request-status, request-type, and record-status local filters.
3. Request report filtering is local and does not trigger extra API calls.
4. Record table filtering is local and does not trigger extra API calls.
5. Existing overview/reports entrypoint separation still passes after the change.

## Notes

- The build still emits the existing Vite chunk-size warning for large frontend bundles.
- This slice does not change backend behavior or approval-center files.
