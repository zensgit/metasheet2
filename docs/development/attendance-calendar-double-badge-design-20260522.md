# Attendance Calendar Double-Badge Design (PR-B)

Date: 2026-05-22
Branch: `frontend/attendance-calendar-double-badge-design-20260522`
Base: `origin/main@2d939402d`
Status: design draft; no implementation yet

## 1. Goal

Make attendance calendar chips communicate three separate facts without mixing them:

1. Day-level calendar verdict: whether this date is effectively a working day.
2. Holiday/source provenance: whether the verdict came from statutory holiday data or company policy.
3. Personal overlays: approved leave, overtime, attendance correction, business trip, or training on that date.

The target user-facing examples:

- National Day anchor: `10-01` can show `国庆节` and `休`.
- Holiday rest period: `09-29` through `10-05` can show a red `休` even when only some dates are the named festival anchor.
- Makeup workday: `10-08` can show a green `班`.
- Company Saturday workday override can also show `班`, but with company provenance in tooltip/accent.
- Approved leave on a normal workday should show `班` plus a secondary `假`, not replace the calendar verdict.

## 2. Current Code Anchors

| Area | Current state | Anchor |
| --- | --- | --- |
| Backend effective calendar | `GET /api/attendance/effective-calendar` composes base holiday/rule, calendar policy layers, and approved request overlays. | `plugins/plugin-attendance/index.cjs:10907`, `:11320` |
| Approved overlays | Only approved `attendance_requests` are loaded; request types map to `personal_leave`, `overtime`, and `attendance_correction`. | `plugins/plugin-attendance/index.cjs:10927`, `:11019`, `:11407` |
| User-specific groups | `userId` mode loads `attendanceGroups` from `attendance_group_members`, so different groups can resolve different holiday lengths. | `plugins/plugin-attendance/index.cjs:11048`, `:11359` |
| Calendar policy scope | `userId` mode allows `org`, `group`, `role`, `user`; `groupId` mode allows `group`; `orgOnly` allows `org`. | `plugins/plugin-attendance/index.cjs:10921` |
| Frontend effective item type | `CalendarEffectiveItem` carries `base`, `effective`, `layers`, and `overlays`. `CalendarEffectiveBase` does not yet declare `dayIndex`; PR-B must extend the TS type to expose the field already returned on the wire by `buildCalendarBaseFromHoliday()`. | `apps/web/src/services/attendance/effectiveCalendar.ts:32`, `plugins/plugin-attendance/index.cjs:11290` |
| Current overlay chip issue | `effectiveCalendarItemToChip()` can set `chip.name` from the first overlay label when no base/effective label exists. That makes overlay the primary visible message. | `apps/web/src/services/attendance/effectiveCalendar.ts:154`, `:177` |
| Current chip tooltip | Tooltip already lists layer chain and overlays, but text is English/raw and not employee-friendly. | `apps/web/src/services/attendance/calendarChipDisplay.ts:93` |
| Multitable Calendar render | `MetaCalendarView` renders one text node per chip and only adds `--with-overlay` as a small dot. | `apps/web/src/multitable/components/MetaCalendarView.vue:61`, `:790` |
| Attendance personal calendar | `AttendanceView` uses effective-calendar chips, but only exposes one `holidayName` string. | `apps/web/src/views/AttendanceView.vue:8069`, `:8090` |
| Source palette | 6 fine-grained source colors already exist: `national`, `manual`, `org`, `group`, `role`, `user`. | `apps/web/src/styles/calendar-source-palette.css:14` |

## 3. Scope

In scope:

- Shared display helper(s) for day badge, overlay badges, employee source category, and tooltip text.
- `MetaCalendarView.vue` double-badge rendering.
- `AttendanceView.vue` personal calendar double-badge rendering.
- Optional reuse in assignment preview chips only if it remains mechanical and low churn.
- Unit/render tests for helpers and both visible consumers.
- Documentation and verification MD.

Out of scope:

- Backend schema/API changes.
- Pending/unapproved request visibility.
- Team availability calendar or cross-user viewer.
- Admin holiday CRUD source-color semantics; admin surfaces keep 6 fine-grained source colors.
- Exact statutory festival-anchor data modeling such as `festivalAnchorDate`. See §7.

## 4. Core Decisions

### D1. Preserve API semantics

Do not merge or rewrite `effective.source`.

The API still returns:

```ts
type CalendarEffectiveSource =
  | 'rule'
  | 'shift'
  | 'rotation'
  | 'national'
  | 'manual'
  | 'org'
  | 'group'
  | 'role'
  | 'user'
```

The UI can derive a coarser employee-facing category, but raw source remains available for tooltip, admin, tests, and debugging.

### D2. Two visual layers

Primary day badge answers: "Is this date a workday or rest day?"

Secondary overlay badges answer: "Does this person have approved leave/overtime/correction/etc. on this date?"

Do not let overlay replace day verdict.

| Scenario | Primary | Secondary | Rationale |
| --- | --- | --- | --- |
| Normal workday + approved leave | `班` | `假` or `假 4h` | Workday fact remains visible. |
| Rest day + approved overtime | `休` | `加 8h` | Rest-day fact remains visible. |
| National Day rest | `国庆节` + `休` | none | `dayIndex === 1` anchor/festival label plus rest verdict. |
| Company Saturday work override | `班` | none | Company policy changed verdict. |
| Correction on workday | `班` | `补` | Attendance correction is personal overlay. |

### D3. Employee source category is two-state

Employee-facing calendar surfaces should show source provenance as:

- statutory: `national`
- company-policy: everything else that is noteworthy (`manual`, `org`, `group`, `role`, `user`)

Admin surfaces keep the existing 6-source palette.

Implementation rule:

- Keep `calendarChipSourceClassName(source)` unchanged for admin/fine-grained consumers.
- Add a new helper for employee surfaces, for example:

```ts
export type CalendarChipEmployeeSourceCategory = 'national' | 'company-policy'

export function calendarChipEmployeeSourceClassName(
  source: CalendarEffectiveSource | undefined,
): string | undefined
```

`national` returns `calendar-source--national`; non-national noteworthy company sources return `calendar-source--company-policy`; `rule/shift/rotation/undefined` return `undefined`.

CSS:

```css
.calendar-source--company-policy { --calendar-source-accent: #3a86ff; }
```

### D4. Approved overlays only

V1 displays only overlays returned by effective-calendar. Backend currently loads `status = 'approved'` requests only.

Pending requests are deferred. If product later wants pending visibility, it should use a different visual contract, such as dashed/grey secondary badges, because pending is workflow state rather than effective fact.

### D5. Overlay labels are localized and compact

Add localized labels for overlay short badges:

| Overlay kind | EN full | EN short badge | ZH full | ZH short badge |
| --- | --- | --- | --- | --- |
| `personal_leave` | Leave | empty | 请假 | `假` |
| `overtime` | Overtime | empty | 加班 | `加` |
| `attendance_correction` | Correction | empty | 补卡 | `补` |
| `business_trip` | Business trip | empty | 出差 | `出` |
| `training` | Training | empty | 培训 | `训` |

The ZH badge uses the short form; tooltip uses the full localized form. In EN locale, the visible short overlay badge text is empty and the tooltip carries the full English label. This follows the product decision that PR-B's compact single-character badges are a Chinese UI affordance; EN users rely on color/outline plus tooltip instead of invented abbreviations such as `L` or `OT`.

### D6. Duration display

Overlay badges show duration only when useful:

- `minutes` missing or invalid: show badge only, e.g. `假`.
- Full-day threshold: use `rule.workMinutes` if available in the consumer; otherwise fallback to `480`.
- `minutes >= fullDayMinutes`: show badge only, e.g. `假`.
- `minutes < fullDayMinutes`: show rounded hours when divisible or sensible, e.g. `假 4h`; tooltip always shows raw minutes.

If PR-B cannot reliably pass `rule.workMinutes` into the shared helper without broad churn, use fallback `480` in v1 and document it in verification MD.

### D7. Day badge text

Day badge is derived from `effective.isWorkingDay`:

- ZH: `true` -> `班`; `false` -> `休`
- EN: empty visible text; tooltip carries `Working day` / `Rest day`

Do not infer work/rest from source.

Holiday/festival label is separate:

- If a non-generated anchor label is available, show it before the day badge.
- Generated holiday-period labels such as `国庆-2` should not become the only visible text.
- When `base.dayIndex === 1`, strip the generated suffix and show the festival anchor label before the day badge, e.g. `国庆节-1` -> `国庆节` + `休`.
- When `base.dayIndex > 1`, prefer the short day badge in the chip and keep the full raw holiday name in tooltip.
- Suffix stripping for v1 is deliberately narrow: `/^(.*?)(?:-|第)(\d+)(?:天)?$/` and only when the parsed numeric suffix matches `base.dayIndex`.

## 5. Proposed Display Model

Add a pure display model in `apps/web/src/services/attendance/calendarChipDisplay.ts`:

```ts
export type CalendarChipDayBadgeKind = 'work' | 'rest'
export type CalendarChipOverlayBadgeKind =
  | 'leave'
  | 'overtime'
  | 'correction'
  | 'business_trip'
  | 'training'

export interface CalendarChipOverlayBadge {
  kind: CalendarChipOverlayBadgeKind
  text: string
  fullLabel: string
  minutes?: number
  requestType?: string
  status?: string
}

export interface CalendarChipDisplayModel {
  titleLabel?: string
  dayBadge: {
    kind: CalendarChipDayBadgeKind
    text: string
    fullLabel: string
  }
  overlayBadges: CalendarChipOverlayBadge[]
  sourceClass?: string
  fineSourceClass?: string
  tooltip?: string
  hasOverride: boolean
  hasOverlay: boolean
}

export function buildCalendarChipDisplay(
  chip: CalendarEffectiveChip,
  options: {
    isZh: boolean
    audience?: 'employee' | 'admin'
    fullDayMinutes?: number
  },
): CalendarChipDisplayModel
```

Notes:

- `sourceClass` is audience-aware; employee surfaces get national/company two-state.
- `fineSourceClass` preserves 6-source class for admin surfaces if needed.
- `titleLabel` is raw user/source data and must not be translated.
- `overlayBadges` is derived from `chip.overlays` and is not written back into `chip.name`.
- When `chip.overlays.length > 0`, the display helper must not trust `chip.name` as a title by default, because current `effectiveCalendarItemToChip()` may derive `chip.name` from the first overlay fallback. The display helper should derive title from `chip.base.name`, `chip.effective.label`, and `base.dayIndex` rules instead. Changing `effectiveCalendarItemToChip()` semantics is deferred to a separate cleanup PR.

## 6. DOM Contract

`MetaCalendarView.vue` should change from one visible text node:

```vue
{{ holiday.name || fallbackHolidayName(holiday) }}
```

to structured but compact segments:

```vue
<span class="meta-calendar__holiday-title" v-if="display.titleLabel">
  {{ display.titleLabel }}
</span>
<span
  class="meta-calendar__holiday-day-badge"
  :class="`meta-calendar__holiday-day-badge--${display.dayBadge.kind}`"
>
  {{ display.dayBadge.text }}
</span>
<span
  v-for="overlay in display.overlayBadges.slice(0, 2)"
  :key="overlay.kind"
  class="meta-calendar__holiday-overlay-badge"
  :class="`meta-calendar__holiday-overlay-badge--${overlay.kind}`"
>
  {{ overlay.text }}
</span>
```

The exact code can be optimized to avoid repeated helper calls, but tests must assert the rendered text, classes, and tooltip.

Do not add `data-*` with localized text. Any data attributes must stay raw enum values.

## 7. Festival Anchor Limitation

The current backend holiday row shape is:

```ts
{ date, name, isWorkingDay, origin }
```

It does not carry a canonical `festivalAnchorDate`.

The sync path can generate day-index names, e.g. `name-1`, via `normalizeHolidayCnDays()` and `formatHolidayDayIndex()`. PR-B should improve display clarity, but should not pretend it can always infer "10-01 is the true National Day anchor" from date/name alone.

V1 behavior:

- Preserve raw `base.name` in tooltip.
- Show clean short `休` / `班` day badge everywhere.
- Show `titleLabel` only when the name is suitable for a compact chip.
- If a generated day-index suffix is detected and `base.dayIndex === 1`, strip the suffix for the visible title and show the festival anchor, e.g. `国庆节-1` -> `国庆节`.
- If a generated day-index suffix is detected and `base.dayIndex > 1`, prefer `休`/`班` in the chip and keep the full name in tooltip.

Future backend enhancement, if exact statutory anchors are required:

```ts
base: {
  name?: string
  festivalName?: string
  festivalAnchorDate?: string
  holidayPeriodName?: string
}
```

That should be a separate backend/API PR, not hidden inside this frontend display slice.

## 8. Surface-Specific Behavior

### Multitable Calendar

Files:

- `apps/web/src/multitable/components/MetaCalendarView.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`

Behavior:

- Use `buildCalendarChipDisplay(chip, { isZh: isZh.value, audience: 'employee' })`.
- Employee source class is national/company two-state.
- Existing `cell.holidays.slice(0, 2)` remains unchanged.
- Overlay badges are inside the same chip, not additional holiday entries.

### Attendance Personal Calendar

Files:

- `apps/web/src/views/AttendanceView.vue`

Behavior:

- Use the same display model for `day.holidayName` replacement or extend `CalendarDay` to carry `calendarDisplay`.
- Show primary day badge and secondary overlay badges in the cell.
- Keep existing status label for attendance record status; do not regress record status rendering.

### Attendance Admin Holiday CRUD

Files:

- `apps/web/src/views/attendance/AttendanceHolidayDataSection.vue`

Behavior:

- Out of PR-B scope unless a small type/test update is required.
- Continue using 6-source/fine-grained origin semantics.
- Future improvement: replace the current `N/M` single-letter admin origin badges (`N = national`, `M = manual`) with `国家同步` / `公司手工`; not required for PR-B.

### Assignment Preview Chips

Files:

- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
- `apps/web/src/views/AttendanceView.vue`

Behavior:

- Only update if the shared helper change forces a type adjustment.
- Admin preview can keep fine source class and existing text in PR-B to avoid scope creep.

## 9. I18n Placement

Do not put employee calendar labels into multitable i18n modules unless they are multitable-specific.

Preferred location:

- Extend `apps/web/src/services/attendance/calendarChipDisplay.ts` with localized pure helpers taking `isZh`.

Rationale:

- This is attendance calendar semantics shared by multitable Calendar and AttendanceView.
- Existing service file already owns calendar chip display helpers.
- Avoid a Vue composable dependency in service code.

If the implementation grows beyond compact helper labels, create:

- `apps/web/src/services/attendance/calendarChipLabels.ts`

but keep it under `services/attendance`, not `apps/web/src/multitable/utils`.

## 10. Tests

### Unit tests

Extend:

- `apps/web/tests/calendarChipDisplay.spec.ts`
- `apps/web/tests/effectiveCalendar.spec.ts`

Cases:

1. Workday with approved leave: display model returns day `班` plus overlay `假`.
2. Rest day with overtime: day `休` plus overlay `加 8h`.
3. National rest day: employee source class is `calendar-source--national`.
4. Manual/org/group/user source: employee source class is `calendar-source--company-policy`; fine source remains available.
5. Overlay i18n: zh returns `假/加/补/出/训`; en returns empty short badge text and full English tooltip labels.
6. Full-day threshold: `minutes=480` -> `假`; `minutes=240` -> `假 4h`.
7. Invalid/missing minutes: badge text has no duration; tooltip preserves available raw fields.
8. Generated day-index label: `dayIndex=1` chip displays stripped festival title + day badge; `dayIndex=2` chip keeps full raw name in tooltip and visible chip can be day badge only.
9. Legacy chip compatibility:
   - Old `CalendarHoliday` shape with only `id/date/name/isWorkingDay` renders `name` plus work/rest class.
   - Missing `overlays` behaves as no overlays.
   - Missing `effective/base/layers` returns a backward-compatible tooltip/fallback rather than throwing.

### Render tests

Extend:

- `apps/web/tests/multitable-calendar-view.spec.ts`
- Attendance personal calendar spec if an existing focused harness is available; otherwise add a narrow render/helper test around the calendar day builder.

Required render cases:

1. `班 + 假` appears for overlay-only workday; no generic `Working day` text.
2. `休 + 加` appears for rest day with overtime.
3. National source renders national accent class; company source renders company-policy class on employee surfaces.
4. Tooltip includes layer chain and overlay details.
5. No localized display string is used in a CSS selector or `data-*`.

### Backend tests

No backend changes expected.

Do not add integration tests unless implementation discovers a backend gap. Existing integration coverage already asserts approved overlays are returned additively.

## 11. Implementation Order

1. Rebase/branch from latest `origin/main`; confirm clean worktree.
2. Preflight grep:
   - `rg -n "OVERLAY_FALLBACK_LABEL|with-overlay|calendarChipSourceClassName|fallbackChipName|buildCalendarChipTooltip" apps/web/src apps/web/tests`
   - `rg -n "effective-calendar|loadApprovedRequestsForOverlay|calendarOverlayKindFromRequestType" plugins/plugin-attendance/index.cjs packages/core-backend/tests`
3. Extend `CalendarEffectiveBase` in `effectiveCalendar.ts` with `dayIndex?: number`.
4. Add/extend display model helpers in `calendarChipDisplay.ts`. The helper must ignore overlay-derived `chip.name` when overlays exist; it should not change `effectiveCalendarItemToChip()` in this PR.
5. Add `.calendar-source--company-policy` to `apps/web/src/styles/calendar-source-palette.css`.
6. Wire `MetaCalendarView.vue` to structured chip segments.
7. Wire `AttendanceView.vue` personal calendar to structured chip segments.
8. Update/extend unit tests.
9. Update/extend render tests.
10. Write verification MD.
11. Run validation commands:
    - `pnpm --filter @metasheet/web exec vitest run apps/web/tests/calendarChipDisplay.spec.ts apps/web/tests/effectiveCalendar.spec.ts apps/web/tests/multitable-calendar-view.spec.ts`
    - Add the focused AttendanceView/calendar spec command chosen during implementation.
    - `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
    - `pnpm --filter @metasheet/web build`
    - `git diff --check origin/main..HEAD`
12. Commit and stop before push for review.

## 12. Risk Register

| Risk | Mitigation |
| --- | --- |
| Overlay hides work/rest fact | Two-layer DOM contract; tests assert `班 + 假` and `休 + 加`. |
| Employee source category loses admin detail | Preserve raw `effective.source`; tooltip shows exact source; admin surfaces keep 6-source helper. |
| `chip.name` remains overlay fallback and fights display helper | Display helper must derive from `chip.effective/base/layers/overlays`, not blindly trust `chip.name`. Unit test overlay-only workday. |
| Festival anchor is over-inferred | PR-B explicitly does not invent `festivalAnchorDate`; raw name stays in tooltip. |
| Full-day duration threshold wrong for non-480 rules | Use consumer-provided `fullDayMinutes` when available; fallback 480 documented and tooltip shows raw minutes. |
| Visual overcrowding in month cells | Compact one-character badges; overlay badges capped to first two in render with tooltip for full details. |
| Pending leave confusion | Pending requests not included; defer separate workflow-state design. |
| i18n drift between Multitable and AttendanceView | Shared service helper takes `isZh`; both surfaces use it. |

## 13. Acceptance Gate

PR-B is implementation-ready only when design review confirms:

- `休/班` remains tied to `effective.isWorkingDay`.
- Approved overlays render as secondary badges, never as the sole primary day verdict.
- Employee surfaces use national/company source category while preserving exact source in tooltip.
- Admin/source fine-grained semantics are not regressed.
- Pending requests remain out of v1.
- Tests cover `班 + 假`, `休 + 加`, national/company source category, duration display, and raw tooltip preservation.
