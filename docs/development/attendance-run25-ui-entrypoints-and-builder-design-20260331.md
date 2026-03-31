# Attendance Run25 UI Entrypoints And Builder Design

## Scope

This slice closes the remaining high-value attendance UI gaps confirmed during `attendance-onprem-run25-20260330` validation:

1. Make `Import` and `Reports` discoverable from the attendance shell instead of forcing operators to hunt for hidden sections.
2. Fix admin table action cells at the `td` level so edit controls stop collapsing in real browsers.
3. Make the structured rule builder and raw JSON editor read like a workbench instead of a squeezed side note.

## Design

### 1. Promote import and report entrypoints inside the attendance shell

- Extend the attendance shell tabs with two explicit destinations:
  - `Reports`
  - `Import`
- Reuse the existing overview/admin implementations instead of creating new routes or duplicate pages.
- Pass an `initialSectionId` into the reused view so the right section is focused immediately:
  - `attendance-overview-request-report`
  - `attendance-admin-import`

This keeps the slice small while removing the “UI entry not found” complaint from product testing.

### 2. Fix the edit-button collapse at the table-cell root

- Keep `.attendance__table-actions` as a flex helper for non-table contexts.
- Override the real table cell back to `display: table-cell`.
- Size the `td` with `width: auto` and `min-width: max-content`.
- Also lock direct child action buttons to inline-flex with a minimum height so the browser has a stable box to lay out.

The bug root was the parent action cell collapsing, not the click handlers.

### 3. Reframe the structured rule builder as a readable workbench

- Treat the builder card and JSON editor as first-class panels with padding, border, and a light background.
- Let the summary chips wrap under the header instead of fighting for horizontal space.
- Make the JSON area visibly “advanced mode” rather than an unlabeled textarea.

This is a layout/readability improvement, not a rule-engine behavior change.

## Non-goals

- No new backend APIs.
- No separate top-level app routes in `App.vue`.
- No change to rule evaluation semantics or stored config shape.
- No attempt to add a full reporting application beyond surfacing the existing report section.
