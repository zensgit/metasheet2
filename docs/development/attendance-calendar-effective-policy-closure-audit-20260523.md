# Attendance Effective Calendar Policy Closure Audit

Date: 2026-05-23

Base: `origin/main@6e1216767` (`feat(attendance): support extra-rest calendar policy quick add (#1788)`)

Branch: `docs/attendance-calendar-effective-policy-closure-audit-20260523`

Scope: documentation-only closure audit for the effective-calendar policy line. No runtime code, schema, migration, payroll, K3, or deploy workflow changes.

## 1. Closure Verdict

The employee-facing and admin-facing holiday policy line is functionally closed for the agreed v1 scope:

- Statutory holiday rows can be shown as employee calendar chips, including generated `dayIndex` suffixes such as `国庆节-1`, `国庆节第1天`, and `国庆节 DAY1`.
- Employee calendar chips preserve the primary day verdict (`休` / `班`) while showing approved personal events as secondary badges (`假` / `加` / `补` / `出` / `训`).
- National source and company-controlled policy source are visually distinguishable for employees: `national` keeps the statutory accent, while `manual/org/group/role/user` collapse into the employee-facing `company-policy` accent.
- Different attendance groups can receive different holiday lengths from the same statutory holiday range.
- Admin/HR quick-add covers both shorter-than-base holidays and longer-than-base extra rest windows.
- Real-route backend coverage guards the previously discovered `base.dayIndex` serialization gap.

The remaining items are intentionally not part of this closure:

- Pending/unapproved leave display.
- Team availability or manager cross-user availability calendar.
- Payroll-specific reporting semantics beyond the effective-calendar verdict already exposed to the calc chain.
- Automatic backend inference that a statutory holiday's festival anchor differs from its rest window.
- Role/roleTags quick-add UX; advanced calendar-policy rows still support those scopes manually.

## 2. Runtime Source Of Truth

| Area | Current owner | Contract locked by |
| --- | --- | --- |
| Effective calendar route | `GET /api/attendance/effective-calendar` in `plugins/plugin-attendance/index.cjs` | Backend integration tests under `packages/core-backend/tests/integration/attendance-plugin.test.ts` |
| Base holiday serialization | `buildCalendarBaseFromHoliday()` and `baseOut.dayIndex` | `effective-calendar accepts group-specific holiday lengths for different users in userId mode` |
| Policy match | `matchCalendarOverride()` + `matchDayIndexFilter()` | Resolver integration tests plus admin quick-add helper tests |
| Approved personal events | `loadApprovedRequestsForOverlay()` | `effective-calendar §6.3 returns approved request overlays additively without merging` |
| Frontend API shape | `apps/web/src/services/attendance/effectiveCalendar.ts` | `apps/web/tests/effectiveCalendar.spec.ts` |
| Employee chip display | `apps/web/src/services/attendance/calendarChipDisplay.ts` | `apps/web/tests/calendarChipDisplay.spec.ts` |
| Multitable calendar rendering | `apps/web/src/multitable/components/MetaCalendarView.vue` | `apps/web/tests/multitable-calendar-view.spec.ts` |
| Personal attendance calendar rendering | `apps/web/src/views/AttendanceView.vue` | `apps/web/tests/attendance-selfservice-dashboard.spec.ts` |
| Admin quick-add form | `apps/web/src/views/attendance/AttendanceCalendarPolicyQuickAdd.vue` | `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts` and `apps/web/tests/attendance-admin-regressions.spec.ts` |
| Override wire conversion | `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts` | `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts` |

## 3. Product Scenario Matrix

| Scenario | Expected user-visible result | Evidence |
| --- | --- | --- |
| National holiday anchor day, for example `国庆节-1` on 10-01 | Employee chip shows festival name plus rest verdict: `国庆节 休` | `calendarChipDisplay.spec.ts` asserts stripped anchor title for `name-1`, `name第1天`, and `name DAY1` |
| National holiday continuation day, for example 10-02 | Employee chip shows only `休`; raw generated name stays in tooltip | `calendarChipDisplay.spec.ts` asserts continuation day title is hidden and tooltip contains `国庆节-2` |
| Company turns a holiday rest day into work for a scoped group | Employee chip shows `班` and company-policy accent; tooltip explains company/group policy source | `calendarChipDisplay.spec.ts` asserts day 4/5 become `班`, source class is `calendar-source--company-policy`, tooltip includes `公司节假日 · 班组日历政策` |
| Group A rests 3 days while Group B rests 5 days for the same holiday row set | Effective-calendar response differs per `userId` because scope context resolves attendance group membership | Backend integration test asserts short user rest dates are 10-01 through 10-03 and long user rest dates are 10-01 through 10-05 |
| Group needs extra rest beyond the base statutory span | Admin quick-add generates a date-range `group` rest override with `from/to`, no `name`, no `dayIndex*` filters | `attendanceCalendarPolicyOverrides.spec.ts` asserts `wire?.name === undefined`, `wire?.dayIndexStart === undefined`, `wire?.dayIndexEnd === undefined`, and `wire?.dayIndexList === []` |
| Group needs fewer rest days than the base statutory span | Admin quick-add generates a `group` workday override using `name contains <holiday>` and `dayIndexStart/dayIndexEnd` | `attendanceCalendarPolicyOverrides.spec.ts` asserts shorter-rest rows create day-index work exceptions |
| Approved leave on a normal workday | Primary day verdict remains `班`; secondary overlay badge shows `假` or `假 4h`; overlay does not replace the verdict | `calendarChipDisplay.spec.ts` asserts `visibleText === "班 假 4h"` and tooltip contains `个人状态: 请假 · 240m` |
| Approved overtime on a rest day | Primary day verdict remains `休`; secondary overlay badge shows overtime; tooltip keeps minute detail | Overlay display helper and multitable calendar tests assert overlay badges and stable overlay tooltip summaries |
| English locale | Visible short badge text is intentionally empty for compact employee chips; tooltip and aria label carry full English detail | `calendarChipDisplay.spec.ts` asserts English day and overlay badge text are empty while tooltip contains `Overlays: Overtime · 120m` |
| Legacy holiday payload without effective-calendar fields | Legacy chip still renders from the old `CalendarHoliday` shape | `calendarChipDisplay.spec.ts` asserts fallback to `Holiday` when effective/base/layers/overlays are absent |

## 4. Guardrail Matrix

| Guardrail | Why it matters | Current automated guard |
| --- | --- | --- |
| Backend must serialize `base.dayIndex` | Without it, employee chips cannot distinguish anchor day from continuation days | Backend integration test reads the real route and asserts `base.dayIndex` for 10-01 and 10-04 |
| Overlay must not rewrite the day verdict | Leave/overtime is personal state; `班`/`休` is the effective calendar truth | `calendarChipDisplay.spec.ts` asserts dual-badge display and ignores overlay-derived `chip.name` for primary display |
| Approved overlays are additive | Multiple requests on the same date must not be merged or collapsed into one vague state | Backend integration test inserts leave, overtime, and correction on the same date and asserts all 3 overlays are returned |
| Employee palette should not expose admin-level source complexity | Employee view needs statutory vs company distinction, not six administrative scopes | `calendarChipEmployeeSourceClassName()` maps `manual/org/group/role/user` to `calendar-source--company-policy` |
| Admin quick-add must not drift between production and extracted component | `AttendanceHolidayRuleSection.vue` exists but production still uses `AttendanceView.vue`; both need the same quick-add behavior | Production-mount regression and extracted component tests both cover shorter-rest and longer-rest quick-add |
| Longer-rest rows must avoid `name/dayIndex*` constraints | Extra rest dates often have no holiday row, so day-index matching would silently miss | Helper tests assert longer-rest wire rows contain only `from/to` plus scope/effective fields |
| Invalid calendar dates must not be silently normalized by JavaScript `Date` | `2026-02-30` can otherwise roll over to March | Helper unit test asserts invalid date input is rejected |

## 5. Verification Evidence Already On Main

### Backend real-route coverage

`packages/core-backend/tests/integration/attendance-plugin.test.ts` includes:

- `effective-calendar §6.1 baseline equals resolveWorkContext for rule + holiday rows`
- `effective-calendar §6.2 applies calendarPolicy with mode gates, priority, and normalize drops invalid`
- `effective-calendar accepts group-specific holiday lengths for different users in userId mode`
- `effective-calendar §6.3 returns approved request overlays additively without merging`
- `effective-calendar role/roleTags override matches DB-backed role context in resolver mode`

Post-merge smoke for #1788 also ran the group-specific holiday length test against a scratch PostgreSQL database and the real HTTP route. The test passed and the scratch database was dropped.

### Frontend focused coverage

The effective-calendar display path is covered by:

- `apps/web/tests/effectiveCalendar.spec.ts`
- `apps/web/tests/calendarChipDisplay.spec.ts`
- `apps/web/tests/multitable-calendar-view.spec.ts`
- `apps/web/tests/attendance-selfservice-dashboard.spec.ts`

The admin quick-add path is covered by:

- `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`
- `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`
- `apps/web/tests/attendance-admin-regressions.spec.ts`

Post-merge smoke for #1788 ran the focused web quick-add suite:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceCalendarPolicyOverrides.spec.ts \
  tests/useAttendanceHolidayRuleSection.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
```

Result recorded after merge: `3 passed (3)`, `33 passed (33)`.

## 6. Known Non-Goals And Future Product Options

### Pending leave

Only approved attendance requests are surfaced in effective-calendar overlays. Pending leave is intentionally excluded because it is workflow state rather than effective calendar truth. If product needs pending leave visibility later, it should be a separate design with a distinct visual treatment such as dashed/transparent badges and explicit `待审批` tooltip text.

### Team availability

The current multitable and attendance personal calendar fetch `userId=<currentUser>`. Manager/team availability requires a separate UX and permission model. Two plausible future directions:

- Record-linked availability lookup: if a row has an owner/responsible-user field, expose that user's availability in context.
- Dedicated team availability view: group users by team and show approved leave/overtime/travel availability across dates.

Neither is required for the current employee holiday-policy closure.

### Admin source granularity

Employee surfaces intentionally collapse non-national sources into `company-policy`. Admin surfaces may keep more detailed `manual/org/group/role/user` distinction because HR/admin users need to diagnose policy scope and priority.

### Automatic statutory anchor inference

The current implementation relies on holiday sync `dayIndex` metadata and admin-provided policy overrides. It does not infer that "National Day is 10-01 but the rest window is 09-29 through 10-05" from public holiday semantics alone. That remains data/config responsibility.

## 7. Residual Risk

| Risk | Severity | Current mitigation |
| --- | --- | --- |
| A future backend refactor drops `base.dayIndex` again | Medium | Real-route integration test asserts `base.dayIndex`; frontend type includes `dayIndex?: number` |
| A future UI refactor makes overlay primary and hides `班/休` | Medium | Helper unit test asserts `班 假 4h`; product acceptance doc states dual-badge contract |
| Admin quick-add and extracted holiday-rule section drift again | Medium | Both hosts mount the shared `AttendanceCalendarPolicyQuickAdd.vue`; production regression test exists |
| A customer expects pending leave to appear | Low/product | Explicit non-goal; only approved requests are queried server-side |
| A customer expects team-wide calendar visibility | Low/product | Explicit non-goal; current API can query other users with permissions, but no multitable team UI exists |

## 8. Audit Verification

This audit is docs-only. It did not re-run the full frontend/backend test matrix because #1788 post-merge smoke already covered the active runtime seam. The audit verified the current main tree by code/test inspection and should be paired with:

```bash
git diff --check origin/main..HEAD
git diff --stat origin/main..HEAD
```

Expected PR scope for this closure audit: exactly one new documentation file under `docs/development/`.

## 9. Recommended Next Step

No immediate follow-up feature is required for the agreed v1 scope.

If product asks for more, the next slices should be separate and ordered by user value:

1. Pending leave visual design, if workflow-state visibility becomes important.
2. Team availability view, if managers need cross-user scheduling.
3. Admin role/roleTags quick-add, if HR needs non-group holiday-length shortcuts.

Do not mix those future product decisions into maintenance fixes for the current effective-calendar policy line.
