# Integration-Core External System Config Preserve Design - 2026-04-27

## Context

External systems store connection configuration and capability flags. A status-only or name-only update previously rebuilt the row from normalized input, so omitted `config` or `capabilities` could overwrite existing values with defaults.

For K3 WISE and similar adapters, that can erase fields such as `baseUrl`, `acctId`, `orgId`, and capability flags during a routine deactivate/reactivate flow.

## Goal

Preserve stored `config` and `capabilities` when an update omits those fields. Explicit values still replace the stored values.

## Design

When updating an existing external system:

```javascript
if (input.config === undefined) updateRow.config = existing.config
if (input.capabilities === undefined) updateRow.capabilities = existing.capabilities
```

This distinction matters:

- omitted field: preserve existing value
- explicit `{}`: clear or replace value
- explicit object: replace value

## Merge Interaction

This branch was merged with current `origin/main` and keeps PR #1194's `kind` and `role` immutability guard. The two protections are complementary:

- `kind` and `role` cannot change after creation
- same-kind metadata/status updates do not wipe stored config or capabilities

## Files

- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/__tests__/external-systems.test.cjs`

## Non-Goals

- This does not deep-merge nested config objects.
- This does not change credential update behavior.
- This does not infer defaults for legacy rows with already-empty config.
