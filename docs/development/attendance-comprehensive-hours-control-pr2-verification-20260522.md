# Attendance Comprehensive Working Hours Control PR2 Verification

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-preview-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Runtime route | Adds only `POST /api/attendance/comprehensive-hours/preview`. |
| Permission | `attendance:admin`. |
| Frontend | None changed. |
| Migration | None added. |
| `attendance_*` fact writes | None added. |
| Direct `meta_*` writes | None added. |
| Multitable writes | None added. |
| Save warning / save block | None added. |
| Data Factory / Bridge Agent | Not touched. |

## Test Coverage

| Test | Coverage |
| --- | --- |
| Existing PR1 helper tests | Period resolution, invalid input, planned-vs-actual separation, cap comparison, stable rows. |
| `previews planned comprehensive hours from effective-calendar producers without writes` | Locks planned producer path, explicit users, stable de-dup/sort, aggregate violation status, and SELECT-only behavior. |
| `previews actual comprehensive hours from attendance summary without planned producers` | Locks actual summary path and proves planned schedule tables are not queried in actual mode. |
| `resolves payroll-cycle preview periods from the database when only cycleId is provided` | Locks payroll-cycle date-range resolution by `cycleId`. |
| `rejects invalid preview requests and reports schema gaps explicitly` | Locks empty scope, invalid cap, invalid period 400, and schema gap 503 `DB_NOT_READY`. |
| `registers only an admin-gated read-only comprehensive-hours preview route` | Locks route method/path/permission and absence of PUT/PATCH/DELETE preview routes. |

## Commands

```bash
node --check plugins/plugin-attendance/index.cjs

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-comprehensive-hours-control.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-workbench.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  tests/unit/attendance-effective-calendar-role-context.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend build

git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Comprehensive-hours helper + preview test | PASS, 11 tests |
| Existing scheduling/effective-calendar focused regressions | PASS, 15 tests |
| Core backend build | PASS |
| `git diff --check` | PASS |

## Notes

This PR does not run live staging evidence because it is a read-only backend preview endpoint and does not add a UI entry. Runtime evidence can be added with PR3 when the admin preview panel exists.

The isolated worktree required `pnpm install --ignore-scripts` before Vitest. That produced unrelated tracked `node_modules` symlink noise in plugin/tool folders; commit staging must explicitly list only the four slice files and must not use `git add -A`.
