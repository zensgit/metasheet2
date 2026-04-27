# Integration-Core External System Kind Immutability Design - 2026-04-27

## Context

External systems define the adapter contract used by pipelines. The `kind` selects the adapter implementation and the `role` determines whether the system is valid as a source, target, or both.

Before this change, updating an existing external system could change `kind` or `role` in-place. That creates a risky identity mutation:

- existing pipelines can point at the same external system ID but suddenly use a different adapter
- credential/config shape may no longer match the adapter kind
- a source-only system can become target-capable without explicit re-wiring

## Goal

Treat `kind` and `role` as creation-time identity fields. Operators can still update metadata, status, config, capabilities, and credentials, but changing adapter identity requires creating a new external system and explicitly reconnecting pipelines.

## Design

`upsertExternalSystem()` now checks the persisted row before applying an update:

```javascript
if (existing.kind !== normalized.kind || existing.role !== normalized.role) {
  throw new ExternalSystemValidationError('kind and role cannot be changed after creation', {
    id: existing.id,
    existingKind: existing.kind,
    existingRole: existing.role,
    requestedKind: normalized.kind,
    requestedRole: normalized.role,
  })
}
```

The error includes both existing and requested values so the REST layer can report a useful 400-class validation failure.

## Behavior

| Operation | Result |
| --- | --- |
| create system with `kind=http`, `role=source` | allowed |
| update same system name/status/config with same `kind`/`role` | allowed |
| update same system from `kind=http` to `kind=erp:k3-wise-webapi` | rejected |
| update same system from `role=source` to `role=target` | rejected |

## Files

- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/__tests__/external-systems.test.cjs`

## Non-Goals

- This does not add a migration for legacy rows; existing rows remain valid.
- This does not block credential/config changes for the same adapter identity.
- This does not add a clone/switch workflow for pipelines; that belongs in a higher-level UI task.
