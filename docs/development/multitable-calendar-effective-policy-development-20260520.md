# Multitable Calendar — Effective Calendar Integration (PR1)

Date: 2026-05-20
Branch: `frontend/multitable-calendar-effective-policy-20260520`
Base: `origin/main@27d82f99b` (Step 3 effective-calendar resolver landed)
Implements: RFC §7 Step 4 — frontend lane, scope C (minimal visual).
Builds on: Step 3 PR #1707.

## Scope

PR1 wires the multitable Calendar view to the new
`/api/attendance/effective-calendar` endpoint and lays down the shared
TypeScript client + chip type that PR2 (attendance personal view + holiday
admin section) will reuse. PR1 deliberately keeps the visual contract
minimal (scope C agreed with Codex): existing `--working`/`--rest` chip
styling stays unchanged; what changes is

- a dotted-bottom `--overridden` marker when a `calendar_policy` layer fired,
- a small `·` after-marker when overlays are attached,
- a native `title` tooltip carrying the full layer chain + overlay summary.

The full source-colored palette (national / org / group / role / user as
distinct hues) is intentionally deferred to PR2 so the visual design lands
once across both multitable and attendance surfaces.

## Hard constraints honored (Codex review of plan)

1. **Shared client lives at `apps/web/src/services/attendance/effectiveCalendar.ts`** (not under `multitable/api/`), so PR2 consumers can import the same types + `fetchEffectiveCalendar` without duplication.
2. **`MetaCalendarView.vue` stays a presentational component**; it does not fetch. The prop type widens from `CalendarHoliday[]` to `CalendarEffectiveChip[]` and `useCalendarDays` keeps the generic shape (`THoliday extends { date: string }`).
3. **`MultitableWorkbench.vue` waits for `currentUserId`** before issuing the effective-calendar request. The visible-range emit can fire before auth resolves; we cache the last emitted range and replay it once `currentUserId` populates so the user does not see an empty calendar in the gap window. Cache key includes `userId` so a stale `rangeKey` cannot block the retry.
4. **No embed-host changes** — origin/main only wires `MultitableWorkbench.vue → MetaCalendarView`; PR1 does not touch `MultitableEmbedHost.vue`.

## Key code anchors

| Concern | File:line (post-PR1) |
| --- | --- |
| Shared types + `fetchEffectiveCalendar` | `apps/web/src/services/attendance/effectiveCalendar.ts` (new) |
| Chip mapper `effectiveCalendarItemToChip` + `isCalendarEffectiveItemNoteworthy` heuristic | same file |
| `EffectiveCalendarFetchError` thrown on non-2xx / `ok=false` | same file |
| Workbench load function — composite cache key, retry on `currentUserId` watch | `apps/web/src/multitable/views/MultitableWorkbench.vue` `loadCalendarHolidays` near 2801 |
| `MetaCalendarView` prop type widening to `CalendarEffectiveChip[]` | `apps/web/src/multitable/components/MetaCalendarView.vue` `defineProps` |
| Chip render with `--overridden` / `--with-overlay` classes + `:title` | `apps/web/src/multitable/components/MetaCalendarView.vue` chip template (3 view modes) |
| Tooltip builder + override-marker helpers | `apps/web/src/multitable/components/MetaCalendarView.vue` `buildHolidayTooltip` / `hasOverrideMarker` |
| Client unit tests | `apps/web/tests/effectiveCalendar.spec.ts` (new) |
| MetaCalendarView UI cases (6 new) | `apps/web/tests/multitable-calendar-view.spec.ts` (extended) |

## Data flow

```
MetaCalendarView (mount, range stable)
        │  visible-range-change emit
        ▼
MultitableWorkbench.onCalendarVisibleRangeChange(range)
        │  cache range, gate on currentUserId
        ▼
fetchEffectiveCalendar({ from, to, userId, suppressUnauthorizedRedirect: true })
        │  apiFetch('/api/attendance/effective-calendar?...')
        ▼
items[] (RFC §4.4 shape)
        │  filter isCalendarEffectiveItemNoteworthy
        │  map effectiveCalendarItemToChip
        ▼
calendarHolidays ref → :calendar-holidays prop → MetaCalendarView cell chip render
```

Failure modes:

- 401/403 (cross-user denied): `apiFetch` does NOT redirect to /login because the service sets `suppressUnauthorizedRedirect: true` by default. The error throws inside the catch; `calendarHolidays` clears to `[]` and the calendar cells keep rendering. Cache key is busted so a later auth/retry can succeed.
- Network / 500: same graceful clear; `console.debug` records the status for diagnostics. No user-facing toast (the calendar is not a critical surface and chip-emptiness is the failure signal).

## Visual contract (scope C)

| Layer state | Chip class(es) | Title tooltip |
| --- | --- | --- |
| National/manual rest day, no policy | `--rest` | `"<date> — Rest day · national"` (+ layer chain if present) |
| National/manual working-day override | `--working` | similar with `working` source |
| Calendar policy fired on top of base | `--{working|rest}` + `--overridden` | `<base> → <policy>` layer chain |
| Overlay present (leave / overtime / correction) | `--{working|rest}` (+ `--overridden` if also policy-overridden) + `--with-overlay` | layer chain + `"Overlays: personal_leave · 240m · approved; ..."` |
| Overlay-only rule day (typical leave/overtime on a regular workday) | `--working` + `--with-overlay` | same overlay summary; chip name derives from first overlay (`Leave` / `Overtime` / `Correction` / overlay.label override) so the user does not see a generic "Working day" |
| Legacy `CalendarHoliday` payload (PR2 fallback) | `--{working|rest}` only | no `title` (returns `undefined` from builder) |

## Known limitations (carried from Step 3)

- `role` / `roleTags` calendar policies remain valid persisted config but the resolver does not match them in v1 (no DB-backed role context); the chip will never show `--overridden` with `source: 'role'` for now.
- `groupId` resolver mode uses the org default rule for base; group `rule_set` working days are not applied in v1.
- PR1 only renders the multitable Calendar view; `AttendanceView.vue` and `AttendanceHolidayDataSection.vue` are PR2.

## Test surface

- `tests/effectiveCalendar.spec.ts` — 16 unit cases (URL shape per mode, default `suppressUnauthorizedRedirect`, missing/multiple mode rejection, `EffectiveCalendarFetchError` on non-2xx / `ok=false`, success unwrap, chip mapper including overlay-only rule day fallback + explicit `overlay.label` precedence, noteworthy heuristic).
- `tests/multitable-calendar-view.spec.ts` — 7 new chip-rendering cases (national base, org override, group override, user override, overlay markers, overlay-only rule day, legacy fallback) on top of the 3 existing tests.
- Full `pnpm --filter @metasheet/web exec vitest run` — 271 passed / 9 failed; the 9 failures are all reproducible on pristine `origin/main` (stale select counts, attendance import timezone fixtures, etc.) and predate this PR; spot-confirmed by stashing the PR changes and re-running the touched suites.
