# Attendance Custom Template Editor Update

## Scope
- Add an inline editor for custom rule templates within the Attendance admin Rule Sets section.
- Allow admins to create custom templates and edit rule conditions/actions with JSON validation.
- Preserve system templates as read-only (lock logic unchanged).

## Changes
- UI: Custom templates list now includes **New** and **Edit rules** actions.
- Editor supports:
  - Edit template description
  - Add/remove rules
  - Edit rule ID, `when` JSON, and `then` JSON
  - Save back into `engine.templates` in the rule set config
- Validation:
  - Rule `when`/`then` must be valid JSON objects
  - Prevents creating custom templates that conflict with system template names

## Files
- `apps/web/src/views/AttendanceView.vue`

## Notes
- System templates remain locked and are restored on save via existing lock logic.
- The editor writes into the existing JSON config and keeps the JSON textarea as an advanced fallback.
