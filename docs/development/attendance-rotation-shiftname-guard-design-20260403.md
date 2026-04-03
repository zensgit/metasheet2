# Attendance Rotation Shift Name Guard Design

## Goal

Close the runtime gap where deleting a shift succeeds even when an active rotation assignment still references that shift by name inside `attendance_rotation_rules.shift_sequence`.

## Current Behavior

- `attendance_rotation_rules.shift_sequence` stores string values.
- Real deployments and manual tests use shift names in that array.
- The existing shift delete guard only checked for the shift UUID string inside `shift_sequence`.
- Result: delete returned `200` for name-based rotation references.

## Change

- Load the target shift before delete.
- Keep the existing active direct-assignment guard.
- Extend the active rotation guard to block delete when any active rotation rule sequence contains either:
  - the shift UUID string
  - the current shift name

## Scope

- Runtime delete guard in `plugins/plugin-attendance/index.cjs`
- Focused integration regression in `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Non-Goals

- This hotfix does not redesign `shift_sequence` to store shift UUIDs only.
- This hotfix does not solve stale historical references caused by prior shift renames.
- If the product wants durable referential integrity across renames, that needs a separate schema evolution.
