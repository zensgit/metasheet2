# Attendance Rule Set Template UI Update

## Scope
- Split rule set templates into system vs custom lists in the Attendance admin UI.
- Lock system templates on save so they cannot be edited by mistake.
- Ensure custom templates remain editable and are merged back into the rule set config.
- Add a custom template fallback (see `CUSTOM_TEMPLATE_FALLBACK`) when none exists.

## Implementation Notes
- Added template grouping and labels in `apps/web/src/views/AttendanceView.vue`.
- Added helper functions to normalize/split templates and to lock system templates during save.
- Added UI list panels to surface system/custom templates and rule counts.

## Validation
- `pnpm --filter @metasheet/web build` (2026-01-29)

## Follow-ups
- Optional: add UI actions to create/edit custom templates directly instead of JSON editing.
- Optional: add server-side validation to enforce template lock rules.
