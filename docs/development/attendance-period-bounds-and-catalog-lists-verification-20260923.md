# Verification: period bounds and catalog lists (#6016, #6017)

Date: 2026-09-23. Design: `docs/development/attendance-period-bounds-and-catalog-lists-design-20260923.md`.

## Commands

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-payroll-window-timezone.test.ts tests/unit/attendance-comprehensive-hours-control.test.ts --watch=false` — 2 files, 50 tests, exit 0.
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendancePeriodBounds.spec.ts tests/attendanceCatalogListPage.spec.ts tests/attendance-admin-regressions.spec.ts` — 3 files, 151 tests, exit 0.
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-admin-anchor-nav.spec.ts` — 1 file, 32 tests, exit 0.

## Pins

- Instant `2026-09-25T16:30:00Z` with start day 26: `Asia/Shanghai` window is `2026-09-26..2026-10-25`; `UTC` window is `2026-08-26..2026-09-25`.
- Date-only `2026-09-26` and UTC-midnight `Date` stay `2026-09-26..2026-10-25` in `America/Los_Angeles`.
- Instant `2026-09-30T16:30:00Z`: comprehensive-hours defaults are October in Shanghai and September in Los Angeles.
- Empty template id uses the default template zone; a missing template falls back to the attendance zone.
- A first page of 1 item with `total: 2` shows “Showing 1 of 2” and Load more appends the second approval flow and rule set. Requests include `pageSize=200`.

## Not run

Full `pnpm test`, `pnpm lint`, `pnpm type-check`, and a browser pass against a running API. The admin UI was exercised in Vitest (jsdom), not in a browser.
