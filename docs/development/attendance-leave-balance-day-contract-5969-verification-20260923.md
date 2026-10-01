# Verification — annual / comp balance day contract (#5969)

Date: 2026-09-23. Design: `docs/development/attendance-leave-balance-day-contract-5969-design-20260923.md`.

## What was checked

- Annual balance days fold only with the live bank day (`standardDayMinutes`). 2250 minutes at 450 prints 5 days, and the card states `1 day = 450 min`. Without that field the card prints hours and minutes (480 minutes → 8 hours, not 1 day).
- Comp time prints hours and minutes and says deduction is in request minutes, including when a day length is passed in.
- The dedicated leave card shows the same `≈ N days (leave-type standard day)` hint as the general form. An annual span of 540 minutes against a 480-minute leave-type day disables submit and names both numbers. A non-annual 540-minute span is not blocked.
- Settle errors keep the server sentence plus a hint that names the two day rulers. The code chip was already rendered from `meta.code`.
- `computeAnnualLeaveStandardDayMinutes` is unchanged: 540 > 480 throws `ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED`; a clean half day at standard 450 deducts 225. `assertAnnualLeaveRequestSettleable` reads remaining minutes and does not `UPDATE` or `INSERT`. The create/pending-edit path calls it only when the annual engine is enabled. Approve still runs the same formula.

## Commands

```text
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendanceEmployeeWorkspacePresentation.spec.ts \
  tests/attendanceEmployeeLeaveRequestCard.spec.ts \
  tests/annualLeaveDayContract.spec.ts
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-halfday-leave-helper.spec.ts \
  -t "G2 — minutes-to-days"
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-admin-regressions.spec.ts \
  -t "overview self-service — the annual leave card"
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-annual-leave-day-contract.test.ts
```

Results: presentation 22 passed, leave card 5 passed, day-contract helper 3 passed, half-day G2 hint 3 passed, overview `/me` wiring 1 passed, backend unit 3 passed.

The L3 case in `packages/core-backend/tests/integration/attendance-plugin.test.ts` was updated so engine-on create of an insufficient, non-whole, or multi-day annual request returns 422 with no pending row, and approve still 422s rows created while the engine was off. That file needs Postgres (`ATTENDANCE_TEST_DATABASE_URL` or `DATABASE_URL`). This environment has no database, so that integration case was not executed.

## Not checked in a browser

No attendance API or database is running here, so the employee overview was not clicked through in a browser. The jsdom mounts above render the balance card and the leave card and drive the wall-clock input that used to submit 540 minutes.

## Open questions

- Live `standardDayMinutes` is the display and approve ruler. Changing it does not rewrite historical lots. A lot granted at 480 and later displayed at 450 will not read as the same day count.
- Create checks the balance but does not reserve it. Two annual requests can both pass create and the second can still 422 on approve.
- Draft #5971 is docs-only and is not a dependency of this fix. It does not change the product behavior this PR changes.
