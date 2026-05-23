# Attendance Effective Calendar Product Acceptance Checklist

Date: 2026-05-23
Branch: `docs/attendance-calendar-product-acceptance-20260523`
Base: `origin/main@2ea571ebe` (`#1781` merged)

## 1. Purpose

This checklist is the product-level acceptance gate for the attendance holiday display line after PR-B and PR-C:

- PR #1779: employee-facing calendar badges for holiday anchors, rest/work verdicts, company/statutory source, and approved overlays.
- PR #1781: real API serialization of `base.dayIndex` plus group-specific effective-calendar acceptance.

It is intentionally product-facing. It does not replace unit/integration tests; it lists the exact scenarios a reviewer or operator should verify before considering the holiday display capability complete.

## 2. Shipped Capability

The employee calendar can now communicate three independent concepts without overloading one label:

| Concept | UI signal | Data source |
| --- | --- | --- |
| Holiday or policy origin | source accent + tooltip | `effective.source`, `base.source`, `layers[]` |
| Day verdict | primary badge `休` / `班` or dayIndex-1 anchor name | `effective.isWorkingDay`, `base.dayIndex`, `base.name` |
| Personal approved event | overlay badge | `overlays[]` from approved attendance requests |

The key distinction is that employee-facing views collapse detailed company policy scope into a clean statutory/company distinction, while tooltips retain the detailed layer chain for admin/debug use.

## 3. Acceptance Matrix

| # | Scenario | Setup | Expected employee display | Expected tooltip/API evidence |
| --- | --- | --- | --- | --- |
| 1 | Statutory anchor day | Generated national holiday `国庆节-1` / `National Day-1` with `base.dayIndex = 1` | `国庆节 休` in zh-CN; EN visible badge text is empty while outline + tooltip carry state | `base.source = national`, `base.dayIndex = 1`, `effective.source = national` |
| 2 | Statutory continuation rest day | Generated national holiday dayIndex 2+ | Compact `休` | Tooltip carries full holiday name/layer chain |
| 3 | Statutory makeup workday | National holiday source or policy makes a holiday period day working | Compact `班` with statutory/company source context | `effective.isWorkingDay = true`; tooltip explains source |
| 4 | Company-wide rest/work override | `calendarPolicy.overrides[]` with `source = org` | Company-policy accent, `休` or `班` verdict | Tooltip says organization/company policy and preserves layer order |
| 5 | Group-specific holiday length | Two users in different attendance groups over same holiday range | Short group sees only day 1-3 as `休`; long group sees day 1-5 as `休` | API differs by `userId`; short group day 4/5 has `calendar_policy` layer and `effective.source = group` |
| 6 | Manual company holiday row | Admin-created holiday row with `origin = manual` | Company-policy visual category | Tooltip identifies manual/company source, not statutory source |
| 7 | Approved leave on a working day | Approved leave request on an otherwise working day | Primary `班` plus secondary `假` / leave overlay; overlay does not replace the day verdict | `overlays[0].kind = personal_leave`; effective workday remains base/policy truth |
| 8 | Approved overtime on a rest day | Approved overtime request on statutory/company rest day | Primary `休` plus secondary `加` / overtime overlay; rest-day fact remains visible alongside the personal event | `overlays[0].kind = overtime`; base/effective source still present |
| 9 | Correction/business-trip/training overlay | Approved request of supported overlay type | Corresponding overlay badge (`补` / `出` / `训`) | `overlays[]` item carries request type and minutes when available |
| 10 | No effective-calendar rows | Holidays not synced or API returns no noteworthy rows | Calendar still renders; existing unsynced/discoverability hint should guide user | No false `休` / `班` badge is invented |

## 4. Non-Goals

These are intentionally not accepted as part of the current shipped line:

- Pending/unapproved leave shown on the employee calendar.
- Team availability or manager cross-user calendar view.
- Calendar policy admin editor UX improvements.
- Per-scope source color palette for employee views beyond statutory/company clarity.
- Payroll/calc-chain behavior changes.

## 5. Manual Review Script

Use this quick script when validating a live or staging environment:

1. Pick a user in a group that has a shorter holiday policy override.
2. Open the employee calendar over a generated statutory holiday range.
3. Confirm dayIndex 1 shows the holiday anchor name plus `休`.
4. Confirm continuation rest days show compact `休`.
5. Confirm policy-overridden workdays show compact `班`.
6. Approve a leave request for one visible working day and confirm the overlay badge appears.
7. Switch to a user in a different group, or call the API with a different `?userId=`, and confirm the visible rest length differs as configured.
8. Inspect the tooltip on a policy-overridden day and confirm it retains the layer chain/source detail.

## 6. Regression Guards

Automated guards already landed:

- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - `effective-calendar accepts group-specific holiday lengths for different users in userId mode`
- `apps/web/tests/calendarChipDisplay.spec.ts`
  - `renders group-specific holiday length results as the same employee company-policy accent`

The PR-C integration test is the important wire guard: it proved `base.dayIndex` must be serialized by the real API, not only present in frontend fixtures.

## 7. Recommended Next Slice

If this line continues, the next useful slice is not another employee rendering change. It should be an Admin/HR configuration slice:

- make `calendarPolicy.overrides[]` easier to configure for group-specific holiday lengths;
- document how to model "group A rests 3 days, group B rests 5 days";
- add admin-facing validation or preview so HR can confirm the resulting effective calendar before employees see it.

Keep pending leave and team availability as separate product designs.
