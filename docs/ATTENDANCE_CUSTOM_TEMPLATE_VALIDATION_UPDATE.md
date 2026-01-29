# Attendance Custom Template Validation Update

## Scope
- Validate custom template rules on save with:
  - Allowed field whitelist
  - Operator compatibility
  - Type checks for condition values
  - Allowed action fields and value types
- Provide error messages that identify the specific rule.

## Validation Rules
- Condition keys must use supported operators: `_exists`, `_contains_any`, `_not_contains`, `_contains`, `_before`, `_after`, `_gt`, `_lt`, `_gte`, `_lte`, `_eq`, `_ne`.
- Field base name must be in the whitelist (or match `clockIn/clockOut` pattern).
- Value types must match operator expectations (boolean/number/time/string/array).
- Action keys must be in allowed list (`overtime_hours`, `overtime_add`, `required_hours`, `actual_hours`, `warning(s)`, `reason(s)`).

## Files
- `apps/web/src/views/AttendanceView.vue`

## Notes
- Errors are shown in the status bar with rule ID or index for定位。
