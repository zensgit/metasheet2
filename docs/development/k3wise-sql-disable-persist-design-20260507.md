# K3 WISE SQL Disable Persist Design - 2026-05-07

## Context

The K3 WISE setup page lets operators disable the SQL Server channel. Before this change, `buildK3WiseSetupPayloads()` returned `sqlServer: null` whenever `sqlEnabled` was false.

That is correct for a brand-new setup with no SQL Server external system. It is wrong for an existing setup: saving the form after switching SQL off did not persist any state change to the registry, so the existing `erp:k3-wise-sqlserver` row could remain `active`.

## Change

- If SQL is disabled and no `sqlSystemId` exists, keep returning `sqlServer: null`.
- If SQL is disabled and `sqlSystemId` exists, return a minimal SQL Server payload with `status: inactive`.
- The inactive payload deliberately omits `config`, `credentials`, and `capabilities` so the backend preserves existing connection details without exposing or clearing secrets.

## Scope

This is a helper-level fix on top of the K3 WISE setup UI stack. The existing save flow already upserts `payloads.sqlServer` when it is present, so no view change is required.

## Impact

Operators can turn off an existing SQL Server channel from the UI and have that choice reflected in `integration_external_systems`.
