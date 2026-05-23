# Attendance Calendar Double-Badge Verification (PR-B)

Date: 2026-05-22
Branch: `frontend/attendance-calendar-double-badge-design-20260522`
Base after rebase: `origin/main@29d01e65f`

## 1. DoD

PASS if all are true:

- `CalendarEffectiveBase.dayIndex?: number` is declared on the frontend type and preserved through `effectiveCalendarItemToChip()`.
- Employee calendar chips render day verdict and personal overlays as separate visual segments.
- Employee surfaces collapse source accent to national vs company-policy while admin/fine-grained consumers still use the existing 6-source helper.
- Overlay-present days do not read overlay-derived `chip.name` as the primary title.
- Existing legacy chips without effective-calendar fields still render safely.
- Target unit/render tests, `vue-tsc`, frontend build, and diff check pass.

## 2. Preflight

Commands:

```bash
rg -n "OVERLAY_FALLBACK_LABEL|with-overlay|calendarChipSourceClassName|fallbackChipName|buildCalendarChipTooltip" apps/web/src apps/web/tests
rg -n "effective-calendar|loadApprovedRequestsForOverlay|calendarOverlayKindFromRequestType|buildCalendarBaseFromHoliday|dayIndex: meta.dayIndex" plugins/plugin-attendance/index.cjs packages/core-backend/tests
```

Key findings:

- `effectiveCalendarItemToChip()` still owns overlay-derived legacy `chip.name`; PR-B keeps it unchanged.
- Employee rendering uses new `buildCalendarChipDisplay()` and ignores overlay-derived `chip.name` when overlays exist.
- Admin/assignment preview consumers still use `calendarChipSourceClassName()` / `fallbackChipName()` / `buildCalendarChipTooltip()` unchanged.
- Backend wire already exposes `base.dayIndex` in `buildCalendarBaseFromHoliday()` via `dayIndex: meta.dayIndex`.

## 3. Implementation Evidence

Changed files:

```text
apps/web/src/services/attendance/effectiveCalendar.ts
apps/web/src/services/attendance/calendarChipDisplay.ts
apps/web/src/styles/calendar-source-palette.css
apps/web/src/multitable/components/MetaCalendarView.vue
apps/web/src/views/AttendanceView.vue
apps/web/tests/calendarChipDisplay.spec.ts
apps/web/tests/effectiveCalendar.spec.ts
apps/web/tests/multitable-calendar-view.spec.ts
apps/web/tests/attendance-selfservice-dashboard.spec.ts
docs/development/attendance-calendar-double-badge-design-20260522.md
docs/development/attendance-calendar-double-badge-verification-20260522.md
```

Design fidelity:

- A1 closed: generated holiday suffix stripping supports `name-1`, `name第1天`, and `name DAY1`; only `dayIndex === 1` shows the stripped anchor title.
- A2 closed: EN short day/overlay badges are empty; tooltip carries full English labels.
- A3 closed: display helper ignores overlay-derived `chip.name` for overlay-primary decisions; `effectiveCalendarItemToChip()` remains backward-compatible.
- A4 closed: `CalendarEffectiveBase.dayIndex?: number` is declared before display helper usage.
- Employee source class: `national -> calendar-source--national`; `manual/org/group/role/user -> calendar-source--company-policy`; `rule/shift/rotation -> undefined`.
- Personal calendar: `AttendanceView` now renders the same structured display model as `MetaCalendarView`.

## 4. Test Evidence

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/calendarChipDisplay.spec.ts tests/effectiveCalendar.spec.ts tests/multitable-calendar-view.spec.ts tests/attendance-selfservice-dashboard.spec.ts --watch=false
```

Output:

```text
✓ tests/calendarChipDisplay.spec.ts  (18 tests)
✓ tests/effectiveCalendar.spec.ts  (18 tests)
✓ tests/multitable-calendar-view.spec.ts  (14 tests)
✓ tests/attendance-selfservice-dashboard.spec.ts  (7 tests)

Test Files  4 passed (4)
Tests       57 passed (57)
```

Coverage points:

- Helper unit: national/company source category, dayIndex suffix stripping, dayIndex continuation, overlay-only workday, full-day threshold, EN empty short badges, legacy fallback.
- Effective-calendar client: `base.dayIndex` preserved by `effectiveCalendarItemToChip()`.
- Multitable Calendar: national anchor `国庆节 + 休`, continuation `休` with raw name in tooltip, company-policy accent, overlay badges, legacy chip compatibility.
- Attendance personal calendar: `清明节 + 休` and approved overtime `班 + 加 3h` render from effective-calendar response.

## 5. Type / Build Evidence

Commands:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web run type-check
pnpm --filter @metasheet/web build
```

Output:

```text
vue-tsc --noEmit: exit 0
type-check: vue-tsc -b exit 0
build: ✓ built in 6.03s
```

Build warning observed:

- Existing Vite warning: `WorkflowDesigner.vue` is both dynamically and statically imported. This is unrelated to PR-B and did not fail the build.

Rebase note:

- The branch was rebased after `origin/main` advanced. The only conflict was in `AttendanceView.vue` near new comprehensive-hours types; the resolution kept the upstream types and applied PR-B's `CalendarDay.calendarDisplay` change. Post-rebase diff is 11 PR-B files only.

## 6. Raw Boundary

Preserved raw data:

- `effective.source` remains the API source token; display only derives an employee category.
- `layers[].source`, `layers[].label`, and `overlays[].minutes` remain visible in tooltip.
- `base.name` raw generated continuation labels such as `国庆节 DAY2` stay in tooltip.
- Overlay backend `label` remains raw when provided; compact badge text uses locale-specific short labels.
- `AttendanceView` admin/assignment preview chip behavior remains on the fine-grained helper.

## 7. Worktree Notes

- Local `node_modules` symlinks were used only to run the web toolchain in the temporary worktree.
- `apps/web/dist/` is ignored build output and is not part of the PR diff.
- No backend, migration, contract, K3, or attendance plugin runtime code changed.
