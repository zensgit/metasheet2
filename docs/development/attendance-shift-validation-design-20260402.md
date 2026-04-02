# Attendance Shift Validation

## Context

Issue [#598](https://github.com/zensgit/metasheet2/issues/598) reported two gaps on the attendance shift endpoints:

- unknown `breakMinutes` payload fields were accepted
- `name` had no practical upper bound

## Decision

- make shift create/update payloads strict so unknown fields are rejected instead of silently ignored
- cap shift `name` at 200 characters
- align the OpenAPI request schema with the runtime behavior

## Scope

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `packages/openapi/src/paths/attendance.yml`

## Expected Outcome

- `POST /api/attendance/shifts` rejects unknown fields like `breakMinutes`
- `PUT /api/attendance/shifts/:id` rejects unknown fields like `breakMinutes`
- create/update both reject names longer than 200 characters
- API docs describe the 200-character `name` limit and disallow extra request properties
