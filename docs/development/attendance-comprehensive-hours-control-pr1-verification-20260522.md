# Attendance Comprehensive Working Hours Control PR1 Verification

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-pr1-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Runtime code | Limited to pure helpers in `plugins/plugin-attendance/index.cjs`. |
| Route / API | None added. |
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
| `resolves month, quarter, year, custom range, and payroll-cycle periods deterministically` | Locks period key/from/to/label semantics. |
| `rejects invalid period input without throwing` | Locks structured error behavior. |
| `aggregates planned minutes from effective calendar-style days without using actual attendance summary` | Locks planned scheduled minutes, holiday/off day 0, overnight shift, explicit planned-minute override, and source retention. |
| `keeps actual minutes sourced from summary payloads separate from planned minutes` | Locks actual summary extraction and null fallback. |
| `builds warning vs violation comparisons from the same cap math` | Locks warn/block status semantics and cap math. |
| `sorts preview rows by userId and switches metric source by mode` | Locks stable row ordering and planned/actual source selection. |

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
| New comprehensive-hours helper test | PASS, 6 tests |
| Existing scheduling/effective-calendar focused regressions | PASS, 15 tests |
| Core backend build | PASS |
| `git diff --check` | PASS |

## Notes

No live staging evidence is applicable for this PR because it exposes no route and performs no write. PR2 will be the first slice where runtime preview evidence can be added.

The isolated worktree required `pnpm install --ignore-scripts` before Vitest. That produced unrelated tracked `node_modules` symlink noise in plugin/tool folders; commit staging must explicitly list only the four slice files and must not use `git add -A`.
