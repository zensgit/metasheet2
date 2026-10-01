# Annual / comp balance day contract (#5969)

Date: 2026-09-23. Product fix for the mismatch #5971 only documented.

## Contract

Keep the two rulers the ledger already uses. Do not add a third, and do not rewrite lots.

1. **Annual bank day** = live `annualLeavePolicy.standardDayMinutes` (normalize fallback 480). Accrual stores `entitlementDays × standardDayMinutes`. Approve deducts `(requestMinutes × standardDayMinutes) / defaultMinutesPerDay` through the existing `computeAnnualLeaveStandardDayMinutes`. Employee-visible annual **days** divide bank minutes by this number, and the card states `1 day = N min`.

2. **Leave-type request day** = that leave type’s `defaultMinutesPerDay`. Quick-fill, the general request form, and the dedicated leave card all show `≈ N days` against this number. One request day (minutes equal to `defaultMinutesPerDay`) deducts exactly one bank day. A wall-clock shift window (09:00–18:00 = 540) is not this day.

3. **Comp time** is minute-native. Grant and approve deduct the request’s minutes. The card shows hours and minutes and says so. It does not print “N days”.

## Why display follows the bank day

480 is only the policy seed. With `standardDayMinutes = 450`, a 5-day grant is 2250 bank minutes. Folding those minutes at 480 prints “4 days …” while approve still deducts in 450-minute days. The employee card must use the same integer approve uses.

`GET /api/attendance/leave-balances/me` adds `dayBasis` for `leaveTypeCode=annual`: `{ minutesPerDay, source: 'annualLeavePolicy.standardDayMinutes' }`. Comp time sends `dayBasis: null`. If the field is missing or not a positive integer, the annual card shows hours and minutes and does not guess 480.

## Why the leave card does not treat 540 as one day

Annual approval does not deduct wall-clock minutes. Silently shrinking a 540-minute span to one leave-type day would change what the employee asked for. v1 already rejects `minutes > defaultMinutesPerDay` (`ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED`). The dedicated card blocks that submit and shows the leave-type day hint. `POST /api/attendance/requests` (and pending edit) runs the same formula, then checks active annual balance, when `annualLeavePolicy.enabled === true`, so the row is not left pending. Approve keeps the same checks for rows created while the engine was off. The check does not deduct; the ledger write stays on approve.

## Ledger

No migration. Historical lots stay in the minutes they were written in. Display uses the **live** policy standard day, the same number approve uses. Changing `standardDayMinutes` does not rewrite old lots.
