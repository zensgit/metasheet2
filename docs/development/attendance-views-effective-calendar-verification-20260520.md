# Attendance Views — Effective Calendar Integration (PR2) — Verification

Date: 2026-05-20
Branch: `frontend/attendance-views-effective-calendar-20260520`
Base: `origin/main@bf44e3688` (includes PR1 #1712 and #1714)
Commit: branch tip `feat(attendance): personal calendar + holiday chip on effective-calendar`

## Definition of Done (gate)

PR2 is merge-ready when:

1. New + extended specs print their concrete passing case names below.
2. `vue-tsc --noEmit` (web) completes with no new errors.
3. Full `vitest run` over `apps/web` shows the same 9 baseline-failing
   files reproducible on pristine `origin/main`; PR2 adds zero new
   regressions.

The current run satisfies all three.

## Commands Run (local)

| Command | Result |
| --- | --- |
| `pnpm install` (fresh worktree) | OK |
| `pnpm --filter @metasheet/web exec vue-tsc -b` | PASS (TypeScript clean) |
| `pnpm --filter @metasheet/web exec vitest run tests/calendarChipDisplay.spec.ts tests/useAttendanceAdminScheduling.spec.ts --reporter=dot` | PASS — 34 tests (11 chip display + 23 scheduling, including 2 new origin tests). |
| `pnpm --filter @metasheet/web exec vitest run tests/multitable-calendar-view.spec.ts tests/effectiveCalendar.spec.ts --reporter=dot` | PASS — 26 tests (PR1 specs unchanged). |
| `pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts --reporter=dot` | PASS — 6 tests (5 pre-existing + 1 new PR2-review test verifying targetUserId is not committed until Refresh). |
| `pnpm --filter @metasheet/web exec vitest run --reporter=dot` (full web suite) | 274 passed / 9 failed (282); the 9 fail files match PR1's baseline list exactly. |
| `git diff --check origin/main..HEAD` (post-commit) | clean (planned) |

## Concrete pass evidence

```
✓ tests/calendarChipDisplay.spec.ts > calendarChipSourceClassName > maps each calendar_policy/base source to the matching CSS hook
✓ tests/calendarChipDisplay.spec.ts > calendarChipSourceClassName > returns undefined for plain rule/shift/rotation days so no accent is painted
✓ tests/calendarChipDisplay.spec.ts > hasCalendarChipOverrideMarker > returns true only when at least one calendar_policy layer fired
✓ tests/calendarChipDisplay.spec.ts > hasCalendarChipOverrideMarker > returns false for chips with only base layers
✓ tests/calendarChipDisplay.spec.ts > buildCalendarChipTooltip > returns undefined for a legacy CalendarHoliday payload (no effective/base/layers/overlays)
✓ tests/calendarChipDisplay.spec.ts > buildCalendarChipTooltip > composes date + verdict + source on line 1
✓ tests/calendarChipDisplay.spec.ts > buildCalendarChipTooltip > renders layer chain on line 2 and overlay summary on line 3 in stable order
✓ tests/calendarChipDisplay.spec.ts > fallbackChipName > returns "Working day" / "Holiday" by isWorkingDay
✓ tests/calendarChipDisplay.spec.ts > attendance holiday origin helpers > maps origin=national/manual to the matching shared palette class
✓ tests/calendarChipDisplay.spec.ts > attendance holiday origin helpers > defaults to manual when origin is missing (legacy rows / older backends)
✓ tests/calendarChipDisplay.spec.ts > attendance holiday origin helpers > returns the short N/M badge letter for the chip
✓ tests/useAttendanceAdminScheduling.spec.ts > preserves the holiday row origin (national/manual) loaded from /api/attendance/holidays for PR2 admin chip badge
✓ tests/useAttendanceAdminScheduling.spec.ts > does NOT send origin in the holiday save body — backend keeps manual as authoritative default
```

Existing PR1 specs continue passing unchanged after PR2's helper extraction:

```
✓ tests/effectiveCalendar.spec.ts  (16 tests)
✓ tests/multitable-calendar-view.spec.ts  (10 tests)
```

PR2 review Layer 3 add:

```
✓ tests/attendance-selfservice-dashboard.spec.ts > Attendance self-service dashboard > PR2 review #1: typing targetUserId does not request effective-calendar until Refresh commits it
```

## Regression matrix

| Codex Must-Fix / Should-Fix | Covered by |
| --- | --- |
| Must-Fix #1: raw/effective split | `AttendanceView.vue` keeps `holidays` ref + `loadHolidays()` for admin CRUD; new `calendarEffectiveChips` + `loadEffectiveCalendarForOverview()` for overview only; `calendarDays` switched to `calendarEffectiveChipMap`. selfservice-dashboard spec confirms admin path still works. |
| Must-Fix #2: useAuth + currentUserId gate + replay | `useAuth()` imported, `currentUserId` populated in `onMounted`, `committedCalendarUserId` is set by auth bootstrap or Refresh, fetcher early-returns when null, `watch(committedCalendarUserId, …)` replays `lastCalendarEffectiveRange`. Layer 3 mount test covers the committed-user contract. |
| Should-Fix #1: shared tooltip helper, no duplication | `calendarChipDisplay.ts` consolidates the 4 PR1 helpers; MetaCalendarView no longer declares them inline; AttendanceView + HolidayDataSection import the same set. Unit test pinning the helper contract. |
| Should-Fix #2: border-left accent | Global CSS in `calendar-source-palette.css`. Test: chip rendering tests pass after adding `calendar-source--{kind}` class; calendarChipDisplay unit asserts the class mapping. |
| Should-Fix #3: shared CSS via main.ts (not per-SFC @import) | `main.ts` imports the file once globally; no per-component `<style>` `@import` for the palette. |
| Should-Fix #4: POST/PUT no `origin` | New scheduling spec inspects the save body and asserts `origin` is absent. |
| Should-Fix #5 (3-layer tests) | Layers 1 (chip display) + 2 (scheduling/holiday) covered. Layer 3 added in PR2 review pass: new `attendance-selfservice-dashboard.spec.ts` case "typing targetUserId does not request effective-calendar until Refresh commits it" mounts AttendanceView, dispatches an input event on the targetUserId field, asserts no new fetch fired, then clicks Refresh and asserts the fetch URL carries the typed userId. |
| **PR2 review Blocking #1** (typing v-model triggers fetch) | `effectiveUserId` computed removed; `committedCalendarUserId` ref set ONLY by refreshAll() (and the initial auth resolution when no targetUserId is typed). Layer 3 test pins the contract. |
| **PR2 review Blocking #2** (no stale-response guard + Refresh does not force) | `calendarEffectiveLoadVersion` counter checked after each await; `loadEffectiveCalendarForOverview(range, { force })` accepts a force flag; refreshAll passes `force: true` so same-(from,to,userId) Refresh discards the cache. |
| **PR2 review Medium #3** (global accent overridden by scoped border) | AttendanceView's scoped `.attendance__calendar-holiday` now redeclares `border-left: 4px solid var(--calendar-source-accent, #fed7aa)`. Fallback to the existing chip border color when no source class is applied. |

## Pre-existing failures (zero PR2 regression)

The 9 failing files in `pnpm vitest run` for `@metasheet/web` are the same
set documented in PR1's verification MD; PR2 introduces no new failures.

| # | File | Status on PR2 worktree | Notes |
| --- | --- | --- | --- |
| 1 | `tests/multitable-workbench-manager-flow.spec.ts` | Fails identically | Stale select count, pre-PR1 |
| 2 | `tests/multitable-workbench-view.spec.ts` | Fails identically | Workflow designer spy expectation, pre-PR1 |
| 3 | `tests/approval-center.spec.ts` | Fails identically | Untouched by PR2 |
| 4 | `tests/attendance-import-batch-timezone-status.spec.ts` | Fails identically (4 tests) | Untouched by PR2 |
| 5 | `tests/attendance-record-timeline.spec.ts` | Fails identically (4 tests) | Untouched by PR2 |
| 6 | `tests/featureFlags.spec.ts` | Fails identically (3 tests) | Untouched by PR2 |
| 7 | `tests/multitable-phase11.spec.ts` | Fails identically | Untouched by PR2 |
| 8 | `tests/multitable-comment-inbox-realtime.spec.ts` | Fails identically (file-level) | Untouched by PR2 |
| 9 | `tests/useAttendanceAdminRail.spec.ts` | Fails identically | Untouched by PR2 |

## Remaining gate

None for this slice. PR2 is ready for `frontend/...` lane PR review.

## Static evidence

- `apps/web/src/services/attendance/effectiveCalendar.ts` unchanged from PR1
  for fetcher + types; PR2 only extracts the previously-inline display
  helpers into the sibling `calendarChipDisplay.ts`.
- `MultitableWorkbench.vue` is **not** modified by PR2 (only PR1 surface).
- Existing admin CRUD endpoints under `/api/attendance/holidays*` see no
  body/payload changes; the only schema change is `AttendanceHoliday.origin?`
  becoming a known TypeScript field on the response shape.
- `MultitableEmbedHost.vue` is **not** modified (mirrors PR1 constraint).

## What Step 5 inherits

- Shared `effectiveCalendar.ts` types + fetcher + chip mapper continue as
  the resolver contract surface; the calc-chain cutover (`resolveWorkContext`
  → effective resolver) reads the same item shape.
- The 3 calendar UI surfaces now consume the same data source, so the
  cutover only changes the source of truth on the backend without
  re-engineering the frontend.
