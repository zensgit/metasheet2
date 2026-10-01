# Attendance admin list silent truncation — verification (2026-09-23)

Design: `docs/development/attendance-admin-list-silent-truncation-design-20260923.md`.
Tracks #6002, #5998, #6000, and #5995. Not merged.

## What was checked

Each listed surface now requests `page=1&pageSize=200` (the existing API cap), stores `total`, and shows `AttendanceListTruncationNotice` when `total` is greater than the loaded row count. Load more appends one page per click and stops at 25 pages, an empty page, or a page that adds no new ids.

| Surface | Evidence |
| --- | --- |
| Import batch list and item detail (#6002) | Composable spec reads batch and item totals and requests page 2. Section spec shows `1 / 3` and `1 / 4` and clicks both load-more buttons. |
| Shifts, rotation rules, rotation assignments, shift assignments, leave types, overtime rules (#5998) | Scheduling spec asserts the paged shift/rotation URLs and appends the next shift page. Overview and self-service specs pin leave-type and overtime-rule URLs at `pageSize=200`. Admin tables and employee-card selects share those arrays and render the notice. |
| Shift-swap list, assignment options, missed-punch candidates (#6000) | Live-view spec asserts shift-swap `pageSize=200` and “Showing 1 of 3.” Missed-punch candidates use `pageSize=200`, show “Showing 1 of 4.”, and the confirm line shows `1 / 4`. Select-all copy says it covers loaded rows only. |
| Payroll cycles and templates (#5995) | Payroll composable spec reads cycle total and loads page 2. Live-view spec mounts the admin payroll section, shows “Showing 1 of 2.”, then loads the second cycle. |

## Commands

From the repo root, after `pnpm install --frozen-lockfile --filter @metasheet/web...`:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendanceAdminListPage.spec.ts \
  tests/AttendanceListTruncationNotice.spec.ts \
  tests/useAttendanceAdminPayroll.spec.ts \
  tests/useAttendanceAdminScheduling.spec.ts \
  tests/useAttendanceAdminImportBatches.spec.ts \
  tests/AttendanceImportBatchesSection.spec.ts
```

Result: 6 files, 62 tests, exit 0.

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-admin-regressions.spec.ts \
  tests/attendance-selfservice-dashboard.spec.ts
```

Result: 2 files, 229 tests, exit 0. Pre-existing Vue warning: `injection "Symbol(router)" not found` on `AttendanceView`.

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-admin-list-truncation.spec.ts
```

Result: 1 file, 2 tests, exit 0. Same router injection warning.

## Not verified in a browser

The attendance UI was not exercised against a running API. These lists only disclose truncation when `total` exceeds the loaded page, which the component tests simulate. Full `vue-tsc` and workspace lint were not run.

## Open questions

- Catalogs above 200 × 25 rows stay disclosed at the load cap. There is no new server filter for that remainder.
- Live payroll and scheduling still use the inline loaders in `AttendanceView.vue`. The matching composables now use the same page contract, and the unused section templates were left as they were.
- Missed-punch select-all still selects loaded rows only. The confirm dialog shows loaded/total. Enqueue is unchanged.
- Import view-items is paged with load more. `fetchAllImportBatchItems` remains the full-impact and CSV path.
- #5991, #5987, and the overview trio in #6010 are untouched.
