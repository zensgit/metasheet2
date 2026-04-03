# Platform Attendance Self-Service Verification

## Scope

Verify that `platform/multitable` mode no longer blocks ordinary employees from attendance self-service due to missing `attendance_employee` role assignment.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff --check
```

## Expected results

- Platform registration includes `attendance:read` and `attendance:write`.
- Platform registration assigns `attendance_employee`.
- Existing platform users without attendance permissions are backfilled during authentication.
- No admin permission expansion is introduced.
