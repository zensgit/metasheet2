# Attendance Request Record Settlement Verification

## Commands

```bash
set -a && [ -f packages/core-backend/.env ] && source packages/core-backend/.env || true && set +a && \
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-plugin.test.ts \
  -t "writes an adjusted attendance record after final approval for a missed check-in request" \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit

git diff --check
```

## Result

- Focused integration: passed
- TypeScript compile: passed
- `git diff --check`: passed

## Verified Behavior

- Final approval for a `missed_check_in` request writes an `attendance_records` row.
- The resulting record is returned from `/api/attendance/records`.
- The resulting record has `status = adjusted`.
- The resulting record carries the approved `first_in_at` timestamp.

## Notes

- The investigation did not find evidence that current main is missing the settlement write itself.
- A separate product question may still remain around how `is_workday` should be derived after request settlement when holidays, shifts, and default rules overlap. That question is outside this regression slice.

