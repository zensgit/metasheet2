# Attendance Calendar Policy Admin UX Design

Date: 2026-05-23
Branch: `docs/attendance-calendar-policy-admin-design-20260523`
Base: `origin/main@0df498c45601` (`#1782` product acceptance merged)

## 1. Purpose

The employee-facing effective-calendar line is now capable of showing statutory/company origin, `休` / `班` day verdicts, group-specific holiday length, and approved-request overlay badges. The remaining product gap is Admin/HR configuration: an operator can technically edit `settings.calendarPolicy.overrides[]`, but the current UI exposes the low-level rule shape and requires the operator to understand `source`, day-index filters, source-filter consistency, and preview modes.

This design defines the next narrow implementation slice: make the existing admin editor safe and understandable for the common "some groups rest fewer/more holiday days" use case, without changing the backend resolver, employee rendering, or payroll semantics.

## 2. Current Code Anchors

| Area | File / lines | Current behavior |
| --- | --- | --- |
| Employee acceptance contract | `docs/development/attendance-effective-calendar-product-acceptance-20260523.md:16-83` | Employee calendar already displays day verdict, source context, overlays, and group-specific holiday length evidence. |
| Production admin UI | `apps/web/src/views/AttendanceView.vue:1417-1555` | Monolithic settings section renders the current `Effective calendar overrides` table, diagnostics, and draft preview panel. |
| Extracted admin component | `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue:107-210` | Similar editor exists in an extracted component, but this component is not mounted by `AttendanceView.vue` on `origin/main`. |
| Override codec / diagnostics | `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts:1-352` | Converts wire rows to form rows and back; drops incomplete scoped rows; warns missing scope, inverted range, and same-source shadowing. |
| Draft preview | `apps/web/src/views/attendance/AttendanceCalendarPolicyPreviewPanel.vue` + `apps/web/tests/AttendanceCalendarPolicyPreviewPanel.spec.ts` | Calls effective-calendar preview with optional unsaved draft overrides. |
| Existing tests | `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`, `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`, `apps/web/tests/useAttendanceAdminConfig.spec.ts` | Cover helper behavior and extracted component/composable behavior; production `AttendanceView.vue` needs explicit coverage for any mounted UI change. |

Important implementation constraint: the extracted `AttendanceHolidayRuleSection.vue` and `useAttendanceAdminConfig.ts` are tested but not currently wired into the routed admin page. The implementation must either update both the monolithic `AttendanceView.vue` and extracted component, or first replace the monolithic settings subsection with the extracted component in a separate refactor. For this slice, the safer path is updating both surfaces while keeping production behavior in `AttendanceView.vue`.

## 3. Product Problem

The employee use case is simple:

> Group A rests 3 days for National Day; Group B rests 5 days; employees should see their own rest length.

The admin representation is not simple. To make "Group A rests only day 1-3" when the base holiday covers day 1-5, HR must create an exception row similar to:

```json
{
  "name": "国庆",
  "match": "contains",
  "dayIndexStart": 4,
  "dayIndexEnd": 5,
  "filters": { "attendanceGroups": ["Group A"] },
  "effective": {
    "source": "group",
    "isWorkingDay": true,
    "label": "国庆调班"
  }
}
```

That is correct, but too low-level for routine HR operation.

## 4. Design Decisions

### D1. Keep the persisted shape unchanged

This slice does not introduce a new backend route, migration, table, or policy schema. It only helps the admin generate the existing `calendarPolicy.overrides[]` rows. Save still goes through `PUT /api/attendance/settings`; preview still goes through the existing effective-calendar preview path.

### D2. Add a group holiday-length quick-add panel

Add a compact "Group holiday length quick add" panel above the advanced `Effective calendar overrides` table.

Fields:

| Field | Type | Default / behavior |
| --- | --- | --- |
| Holiday name | text | Default `国庆`; stored as `name`, `match='contains'`. |
| Attendance group | text or select + free text | Uses existing `attendanceGroupOptions` for suggestions; writes `filters.attendanceGroups`. |
| Base rest days | number | Default `5`; explanation-only input to let HR think in "holiday length" terms. |
| Target rest days | number | Default `3`; must be between `1` and `baseRestDays`. |
| Exception action | derived | If target rest days < base rest days, generate workday exception for `dayIndexStart = targetRestDays + 1`, `dayIndexEnd = baseRestDays`. |
| Label | text | Default `国庆调班` / `Holiday make-up workday`. |

Primary behavior:

- For "base 5 days, group rests 3 days", append one group-scoped row that makes day-index 4-5 working days.
- For "target rest days equals base rest days", show a no-op hint and do not append a row.
- For "target rest days greater than base rest days", do not auto-create rows in v1; show a hint that the org/base holiday length must cover the longer rest period first, or the admin can add advanced rows manually.

This intentionally models exceptions from the base calendar rather than duplicating rows for every group.

### D3. Keep advanced editor visible

The quick-add panel is a helper, not a replacement. The existing table remains available for:

- org-wide exceptions;
- user-specific exceptions;
- exact-date overrides;
- day-index lists;
- advanced excludes.

### D4. Preview must remain backend-owned

After quick-add appends a row, the preview panel should continue to be the source of truth. It already accepts `draftOverrides`, so a user can run group or user preview without saving first.

Enhancement for this slice:

- Add copy beside the quick-add panel: "After adding a quick row, run preview in group or user mode before saving."
- If feasible without broad state coupling, prefill preview from existing advanced editor date fields where present. The quick-add helper itself does not add date fields and must not introduce a frontend resolver.

### D5. Role source remains advanced / caveated

The resolver has known role/roleTag limitations in resolver mode. The quick-add panel must only generate `source='group'` rows. It must not offer role/roleTag quick-add in this slice.

### D6. Production and extracted surfaces must not drift further

Because both `AttendanceView.vue` and `AttendanceHolidayRuleSection.vue` contain similar admin UI, implementation must preserve parity:

- The quick-add panel and helper behavior should appear in both files, or shared into a component used by both.
- Focused tests must cover the extracted component and at least one production `AttendanceView.vue` path or regression spec.
- If implementation discovers that replacing the monolithic section with the extracted component is low-risk, do that as a separate refactor PR, not inside this slice.

## 5. Helper Contract

Add pure helpers in `attendanceCalendarPolicyOverrides.ts` rather than embedding all transformation logic in Vue templates.

Suggested types:

```ts
export interface CalendarPolicyHolidayLengthQuickAddInput {
  holidayName: string
  attendanceGroup: string
  baseRestDays: number
  targetRestDays: number
  label?: string
  localizedDefaultLabel?: string
}

export type CalendarPolicyHolidayLengthQuickAddResult =
  | { kind: 'append'; form: CalendarPolicyOverrideFormState }
  | { kind: 'noop'; reason: 'same_length' }
  | { kind: 'unsupported'; reason: 'target_longer_than_base' | 'invalid_input' }
```

Semantics:

- Trim `holidayName`, `attendanceGroup`, and `label`.
- `baseRestDays` and `targetRestDays` must be finite integers >= 1.
- `targetRestDays < baseRestDays` produces:
  - `name = holidayName`
  - `match = 'contains'`
  - `dayIndexStart = targetRestDays + 1`
  - `dayIndexEnd = baseRestDays`
  - `source = 'group'`
  - `isWorkingDay = true`
  - `attendanceGroups = attendanceGroup`
  - `label = label || localizedDefaultLabel || '<holidayName>调班'`.
- The helper must not create `date`, `from`, `to`, `roles`, `roleTags`, or user filters.

The helper stays locale-agnostic. The Vue caller owns any localized default label; the final `'<holidayName>调班'` fallback only preserves current zh-first admin defaults when the caller omits both explicit label fields. Why pure helper: it gives deterministic unit coverage and keeps the production/extracted UI surfaces from diverging.

## 6. UX Copy

Add an explanation block next to the quick-add panel:

- EN: `Use this for "Group A rests 3 days while the base holiday is 5 days." The helper creates a group-scoped workday exception for the remaining holiday day indexes.`
- ZH: `用于“某个考勤组在 5 天假期里只休 3 天”这类场景。系统会为剩余节假日序号生成班组级调班规则。`

Warnings:

- If holiday sync day-indexing is disabled, day-index quick rules will not match generated holidays. Point admins to `Append day index` under Holiday Sync.
- If target > base, explain that v1 cannot infer additional holiday rows; admin should extend the base holiday range or use advanced overrides manually.
- If attendance group is empty, disable quick-add and show the same `missing_scope` concept as existing diagnostics.

## 7. Implementation Plan

1. Rebase to latest `origin/main`; confirm worktree is clean.
2. Add helper types and quick-add builder to `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts`.
3. Add helper unit tests in `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`:
   - `base=5`, `target=3` creates dayIndex 4-5 workday group override.
   - `target=base` returns no-op.
   - `target>base` returns unsupported.
   - empty group or holiday name returns invalid input.
   - generated row round-trips through `calendarPolicyOverridesFromForm()`.
   - generated row plus a manually-added bare group row pass through diagnostics: the quick-add row emits no `missing_scope`, while the bare row still warns.
4. Add quick-add UI to `apps/web/src/views/AttendanceView.vue`.
5. Add the same UI to `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue`, or extract a small shared subcomponent if implementation shows duplication becoming fragile.
6. Add/extend tests:
   - `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts` for extracted component quick-add.
   - A production mounted coverage point, preferably an existing `AttendanceView.vue` regression spec if one can safely mount the settings section without excessive fixture churn.
   - Existing `AttendanceCalendarPolicyPreviewPanel.spec.ts` only if preview props or copy change.
7. Add verification MD with:
   - exact changed-file list;
   - helper unit outputs;
   - production and extracted UI coverage;
   - confirmation no backend route/migration/plugin write changed;
   - note that role/roleTag quick-add is intentionally absent.
8. Run:
   - `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts apps/web/tests/useAttendanceHolidayRuleSection.spec.ts --watch=false`
   - targeted production `AttendanceView.vue` spec selected during implementation;
   - `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
   - `pnpm --filter @metasheet/web build`
   - `git diff --check origin/main..HEAD`
9. Commit and stop before push for review.

`NODE_OPTIONS=--no-experimental-webstorage` follows the existing attendance frontend test harness used by nearby slices; keep it on the focused vitest command unless the harness is explicitly updated.

## 8. Acceptance Criteria

- HR can generate a valid group-scoped calendar-policy row for "base 5 rest days, this group rests 3 days" without manually editing day-index fields.
- The generated row serializes to existing `calendarPolicy.overrides[]` shape with `source='group'`, required attendance-group filter, `dayIndexStart=4`, `dayIndexEnd=5`, and `effective.isWorkingDay=true`.
- Existing diagnostics still catch missing scope and shadowed rules.
- Draft preview still receives normalized unsaved overrides.
- Production admin page and extracted component do not drift on the new quick-add UI.
- No employee-facing badge behavior changes.
- No backend, migration, attendance fact, payroll, pending-leave, or team-availability changes.

## 9. Deferred

- Configuring longer-than-base holiday spans automatically.
- Role/roleTag quick-add.
- Bulk import/export of calendar-policy overrides.
- Team availability / manager cross-user calendar.
- Pending leave display on employee calendars.
- Refactoring the monolithic attendance admin settings section to exclusively use extracted subsection components.
