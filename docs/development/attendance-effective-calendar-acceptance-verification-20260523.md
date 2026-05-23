# Attendance Effective Calendar Acceptance Verification (PR-C)

Date: 2026-05-23
Branch: `frontend/attendance-calendar-effective-acceptance-20260523`
Base: `origin/main@92c753172`

## 1. DoD

PASS if all are true:

- Backend route acceptance proves two group-scoped users can receive different holiday lengths in `userId` mode.
- API response includes `base.dayIndex` for generated holiday rows, so PR-B's employee chip anchor logic can consume real wire data.
- Frontend display helper renders that result as the expected employee chip sequence.
- Runtime code changes are limited to serializing the already-computed `base.dayIndex`.
- Targeted tests, type-check, build, and diff-check pass.

## 2. Implementation Summary

Files changed:

```text
packages/core-backend/tests/integration/attendance-plugin.test.ts
plugins/plugin-attendance/index.cjs
apps/web/tests/calendarChipDisplay.spec.ts
docs/development/attendance-effective-calendar-acceptance-development-20260523.md
docs/development/attendance-effective-calendar-acceptance-verification-20260523.md
```

Runtime files changed:

```text
plugins/plugin-attendance/index.cjs
```

Runtime change:

- `resolveEffectiveCalendar()` now includes `base.dayIndex` in the serialized `base` object when `buildCalendarBaseFromHoliday()` derived it from the holiday name.
- No resolver matching, policy priority, route validation, schema, or frontend runtime code changed.

## 3. Backend Acceptance

Added integration test:

```text
effective-calendar accepts group-specific holiday lengths for different users in userId mode
```

Acceptance matrix:

| User | Group policy | Expected rest dates | Expected work dates |
| --- | --- | --- | --- |
| short-group user | group override flips dayIndex 4-5 to work | day 1-3 | day 4-5 |
| long-group user | no matching override | day 1-5 | none |

Key assertions:

- `shortItems[0].base.dayIndex === 1`
- day 4 for short-group user has `effective.source === 'group'`
- long-group user has all `effective.source === 'national'`
- long-group user has no `calendar_policy` layers

Real DB gate:

- Scratch PostgreSQL database created from local `.env` connection and migrated before test.
- Initial real-route run failed on `base.dayIndex === undefined`, proving the test catches the serialization gap.
- After the one-line response fix, the same test passed against the migrated scratch DB.
- Scratch DB was dropped after validation.

## 4. Frontend Acceptance

Extended `calendarChipDisplay.spec.ts`:

```text
renders group-specific holiday length results as the same employee company-policy accent
```

Key assertions:

- day badge sequence: `['休', '休', '休', '班', '班']`
- day 1 visible text: `国庆节 休`
- short-group override day visible text: `Short group makeup work 班`
- short-group override day source class: `calendar-source--company-policy`

## 5. Commands

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/calendarChipDisplay.spec.ts --watch=false
```

```text
✓ tests/calendarChipDisplay.spec.ts  (19 tests)
Test Files  1 passed (1)
Tests       19 passed (19)
```

```bash
DATABASE_URL=<scratch> ATTENDANCE_TEST_DATABASE_URL=<scratch> \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-plugin.test.ts -t "group-specific holiday lengths" --run
```

```text
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar accepts group-specific holiday lengths for different users in userId mode
Test Files  1 passed (1)
Tests       1 passed | 75 skipped (76)
```

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

```text
PASS (exit 0)
```

```bash
pnpm --filter @metasheet/web build
```

```text
✓ built in 6.42s
```

```bash
git diff --check
```

```text
PASS (exit 0)
```

## 6. Worktree Notes

- Worktree path: `/private/tmp/metasheet2-prc-effective-calendar-acceptance-20260523`
- Backend runtime change is limited to `plugins/plugin-attendance/index.cjs` response serialization.
- No migration, contract, K3, or frontend runtime code changed.
- Temporary dependency symlinks and `apps/web/dist/` were local validation artifacts and are not part of the intended PR diff.
