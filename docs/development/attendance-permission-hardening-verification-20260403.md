# Attendance Permission Hardening Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/integration/events-api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Focus

- attendance-mode registration now grants immediate self-service attendance permissions and inserts `attendance_employee`
- non-admin authenticated users receive `403` from `/api/events`
- existing admin event-bus integration path remains operational
