# Platform Attendance Self-Service Design

## Context

`platform/multitable` deployments include the attendance plugin, but ordinary users created under `PRODUCT_MODE=platform` only received spreadsheet permissions. As a result, employee self-service attendance endpoints returned `403`, while the product intent is that platform users can still view their own attendance data and submit attendance requests.

## Decision

Treat `platform` and `attendance` as attendance self-service capable product modes.

## Changes

1. New registrations in attendance-capable modes receive:
   - `attendance:read`
   - `attendance:write`
   - `attendance_employee`
2. Existing non-admin users who authenticate in attendance-capable modes and have no attendance permissions are automatically backfilled to `attendance_employee`.
3. The backfill happens inside `AuthService.resolveRbacProfile()` so:
   - `/api/auth/login`
   - `/api/auth/me`
   - authenticated API requests using existing tokens
   all converge on the same self-service behavior.

## Non-goals

- No change to attendance admin or approver authorization.
- No expansion of `/api/events` access.
- No change to PLM gating behavior.
