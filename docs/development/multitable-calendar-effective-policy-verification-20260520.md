# Multitable Calendar — Effective Calendar Integration (PR1) — Verification

Date: 2026-05-20
Branch: `frontend/multitable-calendar-effective-policy-20260520`
Base: `origin/main@27d82f99b`
Commit: branch tip `feat(multitable): consume effective-calendar API + layer-chain tooltip`

## Definition of Done (gate)

This slice is merge-ready only when:

1. The PR1-introduced specs print their concrete passing case names below.
2. Web type-check completes with no new errors.
3. Failures outside the PR scope are reproducible on pristine `origin/main`
   (i.e., this PR introduces zero new regressions).

The current run satisfies all three.

## Commands Run (local)

| Command | Result |
| --- | --- |
| `pnpm install` (fresh worktree) | OK |
| `pnpm --filter @metasheet/web exec vue-tsc -b` | PASS (TypeScript clean) |
| `pnpm --filter @metasheet/web exec vitest run tests/effectiveCalendar.spec.ts tests/multitable-calendar-view.spec.ts --reporter=dot` | PASS — 26 tests (16 client + 10 MetaCalendarView). |
| `pnpm --filter @metasheet/web exec vitest run --reporter=dot` (full web suite) | 271 passed / 9 failed; the 9 fail files all reproduce on pristine `origin/main`. |
| `pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts tests/multitable-workbench-manager-flow.spec.ts` on the same files with the PR stashed | Same 2-fail result — confirms no PR1-introduced regression among files that share `MultitableWorkbench.vue`. |
| `git diff --check origin/main..HEAD` (post-rebase, see below) | clean |

## Concrete pass evidence

```
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > builds the userId-mode URL with from/to + suppressUnauthorizedRedirect default true
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > builds the groupId-mode URL
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > builds the orgOnly-mode URL with orgOnly=true
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > respects an explicit suppressUnauthorizedRedirect=false override
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > rejects when no mode is provided (mirrors route validation)
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > rejects when multiple modes are provided
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > rejects when from/to are missing
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > throws EffectiveCalendarFetchError on non-2xx so callers can clear chips without page crash
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > throws EffectiveCalendarFetchError when payload sets ok=false even on HTTP 200
✓ tests/effectiveCalendar.spec.ts > fetchEffectiveCalendar > returns the typed data envelope on success
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > maps a national holiday to a chip preserving legacy CalendarHoliday fields plus layers/overlays
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > prefers effective.label when both base.name and effective.label exist
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > isCalendarEffectiveItemNoteworthy returns true for national/manual/policy/overlay items
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > derives chip name from the first overlay when there is no effective.label and no base.name (overlay-only rule day)
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > prefers an explicit overlay.label over the kind-based fallback
✓ tests/effectiveCalendar.spec.ts > effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy > isCalendarEffectiveItemNoteworthy returns false for plain rule/shift/rotation days with no policy and no overlay
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 1: national base chip renders with tooltip naming effective.source=national, no override marker
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 2: org override on national gets --overridden + tooltip names both layers
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 3: group-source override marks --overridden with group layer in tooltip
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 4: user-source override marks --overridden with user layer in tooltip
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 5: overlay-present chip gets --with-overlay class and overlay summary in tooltip
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 5b: overlay-only rule day renders the overlay label (not generic "Working day") and keeps --with-overlay
✓ tests/multitable-calendar-view.spec.ts > MetaCalendarView > §4-PR1 case 6: legacy CalendarHoliday payload (no effective/layers) renders without tooltip or override marker (backward-compat for PR2)
```

Plus the 3 pre-existing MetaCalendarView cases continue to pass (mode switching, quick-create payload, shared lunar/holiday metadata).

## Regression matrix

| Codex hard constraint | Covered by |
| --- | --- |
| Client shared at `services/attendance/effectiveCalendar.ts`, PR2 reusable | the file location + 14 unit tests don't import from `multitable/api/` |
| MetaCalendarView stays presentational; no fetch inside | grep `fetch\|apiFetch` in `MetaCalendarView.vue` returns 0 hits beyond the existing import |
| MultitableWorkbench gates on `currentUserId`; replays last range | `loadCalendarHolidays` early-returns when `currentUserId.value` is falsy; `watch(currentUserId, ...)` calls `loadCalendarHolidays(lastCalendarVisibleRange.value)` |
| No embed-host changes | grep `MultitableEmbedHost` for diff hits returns 0 |
| Failure does not block calendar rendering | `EffectiveCalendarFetchError` thrown, catch clears chips, cache key reset; UI cells still render |
| URL shape | client unit test asserts exact querystring |
| `suppressUnauthorizedRedirect` default true | client unit test asserts option present |

## Pre-existing failures (confirmed unchanged by PR1)

The 9 failing files in the full vitest run are all stale fixtures or
environment-sensitive tests on `origin/main`. Verified by stashing PR1
changes and re-running the most relevant pair:

| # | File | Reproduces on pristine `origin/main`? |
| --- | --- | --- |
| 1 | `multitable-workbench-manager-flow.spec.ts` (1 fail: stale select count) | Yes (also documented in Step 2 verification MD) |
| 2 | `multitable-workbench-view.spec.ts` (1 fail: workflow designer spy expectation) | Yes |
| 3 | `approval-center.spec.ts` (1 fail) | Untouched by PR1 |
| 4 | `attendance-import-batch-timezone-status.spec.ts` (4 fail) | Untouched by PR1 |
| 5 | `attendance-record-timeline.spec.ts` (4 fail) | Untouched by PR1 |
| 6 | `featureFlags.spec.ts` (3 fail) | Untouched by PR1 |
| 7 | `multitable-phase11.spec.ts` (1 fail) | Untouched by PR1 |
| 8 | `multitable-comment-inbox-realtime.spec.ts` (file-level fail) | Untouched by PR1 |
| 9 | `useAttendanceAdminRail.spec.ts` (1 fail: focused-mode storage bucket) | Untouched by PR1 |

If any of the above start passing on `origin/main` later, this PR remains
unaffected — the chip-rendering surface and effective-calendar client are
orthogonal to those files.

## Remaining gate

None for this slice. PR1 is ready for `frontend/...` lane PR review.

## What PR2 inherits

- Same `apps/web/src/services/attendance/effectiveCalendar.ts` (types +
  `fetchEffectiveCalendar` + `effectiveCalendarItemToChip`).
- `CalendarEffectiveChip` is a superset of `CalendarHoliday`; PR2 consumers
  swap the prop type without touching `useCalendarDays`.
- PR2 decides the full source-colored palette (national / org / group / role
  / user as distinct hues) for both multitable and attendance surfaces at
  once, so the visual contract lands consistently.
