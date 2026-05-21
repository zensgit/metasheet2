# Attendance Views — Effective Calendar Integration (PR2)

Date: 2026-05-20
Branch: `frontend/attendance-views-effective-calendar-20260520`
Base: `origin/main@bf44e3688` (includes PR1 #1712 and #1714)
Implements: RFC §7 Step 4 — frontend lane, follow-up to PR1.
Builds on: Step 3 PR #1707 (resolver + read-only API) + Step 4 PR1 #1712
(multitable Calendar consumer + shared service + chip mapper).

## Scope

PR2 finishes Step 4 by wiring the **personal attendance calendar** and the
**holiday admin chip** to the same effective-calendar surface PR1 built for
multitable, and ships the full source palette across all three calendar
surfaces in one cohesive visual landing.

Delivered:

- AttendanceView personal calendar reads `/api/attendance/effective-calendar`
  (userId mode), with a raw/effective split that keeps the admin Holiday CRUD
  page using `/api/attendance/holidays` for editing.
- AttendanceHolidayDataSection chips expose holiday `origin` (national vs
  manual) as a small `N`/`M` badge + a shared source-palette border accent.
- Shared `apps/web/src/styles/calendar-source-palette.css` consumed by all
  three calendar consumers; `border-left: 4px` accent per source layer.
- Chip-display helpers (`buildCalendarChipTooltip`, `hasCalendarChipOverrideMarker`,
  `calendarChipSourceClassName`, `fallbackChipName`, plus the new
  `calendarChipOriginClassName` / `calendarChipOriginBadge`) extracted to
  `apps/web/src/services/attendance/calendarChipDisplay.ts` so multitable
  + attendance consumers share one implementation.

Not delivered:

- Step 5 calc-chain cutover — still planned as the last slice.
- Translation surface for the chip tooltip text (currently English fallback,
  matching PR1's convention). A separate i18n slice can localize.

## Codex review constraints honored

### Must-Fix #1: Raw/effective split in AttendanceView

`holidays` (`AttendanceHoliday[]`) keeps feeding the admin CRUD page via
`holidaySectionBindings`; it is loaded by `loadHolidays()` and posted/put
through the existing flow. The new `calendarEffectiveChips`
(`CalendarEffectiveChip[]`) feeds **only** the personal `calendarDays`
computed via the parallel `calendarEffectiveChipMap`. Editing a holiday
still goes through the raw-row endpoint with the original row id.

### Must-Fix #2: `useAuth()` for `currentUserId`

AttendanceView has no `currentUserId` ref; it has `targetUserId` + a
`normalizedUserId()` helper for the optional manual selector. PR2 imports
`useAuth()`, populates `currentUserId` on mount via `getCurrentUserId()`,
and uses `committedCalendarUserId` (see PR2 review Blocking #1 below) as
the gated input to the fetcher. The fetcher returns early when
`committedCalendarUserId.value` is null; a watch on `committedCalendarUserId`
replays the cached `lastCalendarEffectiveRange` once it resolves.

### PR2 review Blocking #1: live v-model vs Refresh-committed userId

The initial PR2 used `effectiveUserId = computed(() => normalizedUserId() ?? currentUserId.value ?? null)`,
which means every keystroke in the targetUserId input would update the
computed and immediately trigger an effective-calendar fetch. That
desynced calendar chips from summary/records/requests (those only update
on Refresh). Fix: `committedCalendarUserId` ref is set ONLY by
`refreshAll()` and by the initial auth resolution; live input edits do
nothing to it. Layer 3 mount test pins the contract.

### PR2 review Blocking #2: stale-response guard + Refresh force

Initial PR2 had no `loadVersion` counter; rapid month/user switches could
let an older response overwrite a newer one. Also, `refreshAll()` did not
bypass the cache when (from, to, userId) was unchanged, so chips could
stay stale even after explicit Refresh. Fix: bump
`calendarEffectiveLoadVersion` per call and discard responses whose
version no longer matches; `loadEffectiveCalendarForOverview(range, { force })`
accepts a force flag; `refreshAll()` passes `force: true`.

### PR2 review Medium #3: scoped border specificity

`apps/web/src/styles/calendar-source-palette.css` applies
`border-left: 4px solid var(--calendar-source-accent, transparent)` via a
single global selector, but AttendanceView's scoped
`.attendance__calendar-holiday` selector has higher specificity (scoped
selectors carry a `[data-v-...]` attribute) and its `border: 1px solid`
shorthand wins. Fix: the scoped rule now redeclares
`border-left: 4px solid var(--calendar-source-accent, #fed7aa)` so it
consumes the same variable; the fallback to `#fed7aa` preserves the
original chip border color when no source class is present.

### Should-Fix #1: Shared tooltip / source-class helper

PR1's tooltip + override-marker helpers (which lived inside MetaCalendarView)
moved to `apps/web/src/services/attendance/calendarChipDisplay.ts`.
MetaCalendarView now imports the shared exports; AttendanceView imports the
same set; HolidayDataSection imports the origin helpers. Three consumers,
one implementation.

### Should-Fix #2 + #3: Border-left accent palette in a single shared CSS

`apps/web/src/styles/calendar-source-palette.css` is imported once from
`apps/web/src/main.ts`. It both sets `--calendar-source-accent` per source
class and applies `border-left: 4px solid var(--calendar-source-accent, transparent)`
to any element carrying a `calendar-source--{kind}` class — no per-SFC
duplication or scoped/import drift.

### Should-Fix #4: `origin` is read, never written by admin POST/PUT

`AttendanceHoliday.origin?: 'national' | 'manual'` is optional and only
parsed from the API response. The admin create form (`holidayForm`) does
not carry an `origin` field, and the new contract test asserts the save
body has no `origin` key — Step 2 backend's `manual` default stays
authoritative.

## Key code anchors

| Concern | File:line (post-PR2) |
| --- | --- |
| Shared chip-display helpers (extracted from MetaCalendarView) | `apps/web/src/services/attendance/calendarChipDisplay.ts` (new) |
| Source palette CSS + border-left consume rule | `apps/web/src/styles/calendar-source-palette.css` (new), imported in `apps/web/src/main.ts` |
| `AttendanceHoliday.origin?` type | `apps/web/src/views/attendance/useAttendanceAdminScheduling.ts:40+` |
| Holiday CRUD chip — origin badge + source class + tooltip | `apps/web/src/views/attendance/AttendanceHolidayDataSection.vue` chip render area + chip-origin CSS |
| AttendanceView raw `holidays` (CRUD, unchanged) | `apps/web/src/views/AttendanceView.vue` `holidays` ref + `loadHolidays` |
| AttendanceView NEW `calendarEffectiveChips` / `loadEffectiveCalendarForOverview` / `committedCalendarUserId` / watchers | `AttendanceView.vue` near `holidayMap` computed |
| AttendanceView `calendarDays` switched to read `calendarEffectiveChipMap` + `sourceClass` + chip tooltip | `AttendanceView.vue` calendarDays computed |
| MetaCalendarView refactor — helpers imported from `calendarChipDisplay.ts`; source class applied to chip | `apps/web/src/multitable/components/MetaCalendarView.vue` |

## Visual contract (PR1 + PR2 combined)

| Cell state | Classes | Notes |
| --- | --- | --- |
| National/manual rest day | `--rest` (existing red) + `calendar-source--{national\|manual}` | source-color border-left from shared palette |
| Working-day override row | `--working` (existing green) + `calendar-source--{national\|manual}` | |
| Calendar policy fired on top | above + `--overridden` (dotted bottom, PR1) + `calendar-source--{org\|group\|role\|user}` | tooltip carries layer chain |
| Overlay present | above + `--with-overlay` (dot suffix, PR1) | tooltip carries overlay summary |
| Plain rule day with overlay | `--working` + `--with-overlay` (no source class) | chip name derives from first overlay (PR1 fallback) |
| Admin holiday chip | `attendance__holiday-chip` + `--working`/`--holiday` + `calendar-source--{national\|manual}` + `N`/`M` text badge | hover discloses sync vs manual source |

## Source palette

| Source | Border accent | Semantic |
| --- | --- | --- |
| `national` | `#d73a4a` red | from `/holidays/sync` |
| `manual` | `#6e7681` gray | org baseline (admin handwritten) |
| `org` | `#fb8500` orange | company override of national/manual |
| `group` | `#3a86ff` blue | group calendar policy override |
| `role` | `#9b5de5` purple | role-based override (v1 inert in resolver, valid config) |
| `user` | `#063070` deep blue | user-specific override |
| `rule` / `shift` / `rotation` | (no accent) | default working day |

## Known limitations (carried forward)

- `role` / `roleTags` calendarPolicy entries are still inert in the
  effective-calendar resolver (no DB-backed role context in v1). PR1's
  test guards this contract.
- `groupId` resolver mode uses the org default rule for base; group
  `rule_set` working days are not applied in v1.
- AttendanceView fetch gating + replay mirrors PR1 Workbench's stale-response
  protection while committing `targetUserId` only on Refresh. A dedicated
  selfservice-dashboard mount test pins that typing in the user field does not
  trigger an effective-calendar fetch until Refresh commits the value.

## Test surface (PR2 contributions)

- `apps/web/tests/calendarChipDisplay.spec.ts` (new) — 11 unit cases covering
  source class derivation, override marker, tooltip composition, fallback
  name, holiday origin class + badge.
- `apps/web/tests/useAttendanceAdminScheduling.spec.ts` (extended) — origin
  roundtrip from `/api/attendance/holidays` response into `holidays.value`;
  admin save body asserts no `origin` field (Should-Fix #4).
- PR1's existing specs (multitable Calendar view + effectiveCalendar client)
  continue passing unchanged — `calendarChipDisplay` extraction did not
  alter behavior; MetaCalendarView simply imports the same helpers it
  used to declare inline.

## Migration / rollout notes

- The shared CSS is loaded globally at `main.ts`; no per-page bundling cost
  beyond a few KB.
- AttendanceView's personal calendar will briefly show no chips during the
  auth-resolving window (compared to the old flow which always rendered
  holidays from `/api/attendance/holidays` immediately). This is acceptable
  by design — the personal view depends on knowing who the user is. Once
  PR2 lands, the watch+replay pattern ensures the chips populate as soon as
  auth resolves.
- Admin CRUD is unchanged in observable behavior; only the chip layer gains
  the origin badge + border accent.
