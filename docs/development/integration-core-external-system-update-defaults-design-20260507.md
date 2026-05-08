# Integration Core External System Update Defaults Design - 2026-05-07

## Context

External system creation intentionally defaults omitted `role` to `source` and omitted `status` to `inactive`.

The same normalized values were also used for updates. That made partial updates unsafe:

- Updating an active system without `status` could silently write `inactive`.
- Updating a target or bidirectional system without `role` could be treated as an attempted role change to `source` and fail the immutable kind/role guard.

This matters for the ERP/PLM setup UI and API because they naturally send partial edits for config, credentials, or status changes.

## Change

- Keep create defaults unchanged.
- On update, preserve `existing.role` when `input.role` is omitted.
- On update, preserve `existing.status` when `input.status` is omitted.
- Keep explicit role/status values validated exactly as before.

## Scope

This PR changes only the update path in `plugins/plugin-integration-core/lib/external-systems.cjs`.

## Impact

- Partial external-system updates no longer disable active systems by omission.
- Target/bidirectional systems can update config or credentials without resending role every time.
- Existing immutability enforcement still blocks explicit kind/role changes.
