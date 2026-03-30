# Attendance Run24 UI Follow-up Design

## Scope

This slice closes the two operator-facing regressions confirmed during `attendance-onprem-run24-20260330` validation:

1. Retire the `Show all sections` admin-console mode so the right pane always stays focused on the active section.
2. Fix attendance admin action cells whose `td.attendance__table-actions` could collapse to `0x0` in the deployed browser, hiding `Edit` buttons even though the handlers still worked.

It also hardens the structured rule builder header layout so the summary badges and preview actions wrap instead of squeezing the form on narrower desktop widths.

## Design

### 1. Remove the operator-facing show-all toggle

- Keep `adminFocusedMode` as the only supported runtime mode.
- Normalize any old persisted `false` value back to `true`.
- Remove the `Show all sections` / `Focus current section` toggle button from the current-section bar.
- Update the current-section copy so it no longer references a retired all-sections mode.

### 2. Fix admin table action-cell sizing at the cell level

- Keep `.attendance__table-actions` as a flex container for both `td` and non-table wrappers.
- Add a table-cell-specific rule for `.attendance__table td.attendance__table-actions`:
  - `width: 1%`
  - `min-width: max-content`
  - `height: auto`
  - `vertical-align: middle`
- This anchors the width on the `td` itself instead of relying on child button min-size.

### 3. Harden structured rule builder layout

- Make the top-level rule-builder headers wrap.
- Let the summary chip row fall below the title block instead of compressing controls.
- On narrower widths, stack the rule-builder and preview headers vertically.

## Non-goals

- No new import/report pages.
- No change to attendance API behavior.
- No attempt to reintroduce an alternate “show all sections” mode behind another control.
