# Attendance Run25 UI Entrypoints And Builder Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-experience-entrypoints.spec.ts tests/useAttendanceAdminRailNavigation.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expectations

- The attendance shell exposes explicit `Reports` and `Import` tabs.
- `tab=reports` focuses the existing request-report section immediately.
- `tab=import` focuses the existing admin import section immediately.
- Admin action cells render as real table cells rather than collapsing flex boxes.
- The structured rule builder and JSON panel present as readable workbench panels.

## Results

- `git diff --check`: pass
- `pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-experience-entrypoints.spec.ts tests/useAttendanceAdminRailNavigation.spec.ts --watch=false`: pass (`35/35`)
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`: pass
- `pnpm --filter @metasheet/web build`: pass

## Notes

- The new entrypoint test suite locks the tab wiring so `Reports` and `Import` remain discoverable without duplicating entire pages.
- The action-cell regression test asserts the root `td.attendance__table-actions` style change because `jsdom` cannot reproduce real browser box sizing for the previous `0x0` collapse.
- Final confirmation for the structured rule builder remains a browser smoke on the packaged build because this slice is primarily visual.
