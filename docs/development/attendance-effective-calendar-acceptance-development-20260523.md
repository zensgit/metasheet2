# Attendance Effective Calendar Acceptance Development (PR-C)

Date: 2026-05-23
Branch: `frontend/attendance-calendar-effective-acceptance-20260523`
Base: `origin/main@92c753172` (`#1779` merged)

## 1. Goal

Close the product-level acceptance gap after PR-B double-badge rendering:

- statutory holiday anchor and rest/work verdicts are already rendered by PR-B;
- approved overlays are already rendered by PR-B;
- this slice adds an explicit acceptance proof that different attendance groups can see different holiday lengths through the real `userId` effective-calendar API.

The motivating scenario is National Day-style scheduling:

- one group rests 3 days;
- another group rests 5 days;
- the employee calendar should show each employee's own effective rest/work days.

## 2. Scope

In scope:

- Backend integration acceptance for `GET /api/attendance/effective-calendar` in `userId` mode with two group memberships.
- Minimal backend response fix if the acceptance test finds a real serialization gap.
- Frontend display-helper fixture proving the resulting day sequence renders as compact employee chips.
- Development and verification MD.

Out of scope:

- Backend resolver behavior changes.
- Pending/unapproved leave visibility.
- Team availability or cross-user calendar UI.
- Admin calendar-policy editor changes.
- Overlay color/design token adjustments.

## 3. Existing Coverage Before PR-C

Already covered before this slice:

- `effective-calendar §6.1`: baseline rule + holiday rows.
- `effective-calendar §6.2`: calendarPolicy mode gates, priority, normalization, and one group-policy case.
- `effective-calendar §6.3`: approved request overlays are additive and do not change effective workday.
- PR-B frontend tests: dayIndex anchor, generated continuation days, overlay secondary badges, employee national/company source category.

Missing acceptance:

- two users in different attendance groups over the same holiday range receiving different effective rest lengths from the real API.

## 4. Implementation

### Runtime fix

The real route acceptance initially exposed a backend gap: `buildCalendarBaseFromHoliday()` already computed `base.dayIndex`, but `resolveEffectiveCalendar()` omitted it when serializing `baseOut`.

Fix:

- Add `baseOut.dayIndex = base.dayIndex` when present.
- No resolver matching semantics changed.
- No database schema, route validation, policy priority, or frontend runtime code changed.

### Backend integration

Add a focused integration test:

`effective-calendar accepts group-specific holiday lengths for different users in userId mode`

Setup:

- Insert 5 national rest days: `National Day-1` through `National Day-5`.
- Create two attendance groups:
  - short holiday group
  - long holiday group
- Assign one user to each group.
- Save one `calendarPolicy.overrides[]` group policy:
  - `dayIndexStart: 4`
  - `dayIndexEnd: 5`
  - `filters.attendanceGroups: [shortGroupName]`
  - `effective.source: 'group'`
  - `effective.isWorkingDay: true`

Assertions:

- short-group user sees rest dates only on day 1-3 and work dates on day 4-5.
- long-group user sees rest dates on all day 1-5.
- short-group day 4 has `effective.source === 'group'`.
- long-group items remain `effective.source === 'national'` and have no `calendar_policy` layers.
- `base.dayIndex` is present, proving the PR-B display anchor can consume the API response.

### Frontend helper fixture

Extend `calendarChipDisplay.spec.ts` with a compact fixture for the same 5-day scenario:

- day badges render `休, 休, 休, 班, 班`.
- day 1 renders stripped anchor `国庆节 休`.
- group override day renders `Short group makeup work 班`.
- group override day uses `calendar-source--company-policy`.

## 5. Risk Notes

| Risk | Mitigation |
| --- | --- |
| Integration test mutates shared attendance settings | Preserve current `calendarPolicy`, restore it in `finally`. |
| Group policy accidentally affects all users | Assert long-group user has no `calendar_policy` layers. |
| UI claims support but API lacks group-specific result | Backend test hits the real route with `userId` mode. |
| Product scope expands into team availability | Deferred; this slice only proves self-calendar correctness. |

## 6. Acceptance Gate

PR-C is complete when:

- targeted frontend helper test passes;
- targeted backend integration test passes against a migrated scratch PostgreSQL database;
- `vue-tsc` passes;
- frontend build passes;
- diff check is clean;
- runtime source changes are limited to the `base.dayIndex` response serialization fix.
