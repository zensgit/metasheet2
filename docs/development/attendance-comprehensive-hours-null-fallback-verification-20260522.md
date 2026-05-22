# Attendance Comprehensive Hours Null Fallback Verification

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-null-fallback-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Changed helper | `buildAttendanceComprehensivePlannedMinutesFromDays()` only. |
| Route / API | None added. |
| Frontend | None changed. |
| Migration | None added. |
| Attendance writes | None added. |
| Save warning / block | None added. |
| Data Factory / Bridge Agent | Not touched. |

## Regression Case

The existing planned-minutes test now includes two working days with nullable or
blank explicit override values:

| Input | Expected |
| --- | --- |
| `plannedMinutes: null`, shift `10:00..17:30` | fallback to `450` minutes |
| `planned_minutes: ''`, shift `08:00..12:00` | fallback to `240` minutes |

This locks the desired distinction between a true explicit `0` override and an
absent override value.

## Commands

```bash
node --check plugins/plugin-attendance/index.cjs

NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/vitest run \
  packages/core-backend/tests/unit/attendance-comprehensive-hours-control.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend build

git diff --check origin/main...HEAD
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Comprehensive-hours helper test | PASS, 6 tests |
| Core backend build | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Note

The isolated worktree does not have its own `node_modules`, so the local Vitest
run used the already-installed root workspace dependency path. The core-backend
build used temporary local dependency links, then removed generated ignored
outputs before commit. CI should still use the normal workspace `pnpm` commands.
