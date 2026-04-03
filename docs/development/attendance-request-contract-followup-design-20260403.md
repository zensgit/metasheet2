# Attendance Request Contract Follow-up Design

## Goal

Reduce trial-and-error around attendance request creation by making the API accept the snake_case payload variants used in manual testing and by returning actionable validation details when request creation fails.

## Scope

- Accept snake_case aliases for attendance request create/update payloads.
- Return field-level `details` for request validation failures.
- Clarify payroll cycle generation usage in OpenAPI and a quickstart doc.

## Non-goals

- Rework the attendance request business model.
- Replace payroll cycle generate semantics with payroll cycle create semantics.
- Add CSV export support.
