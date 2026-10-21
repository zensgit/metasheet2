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

> **Superseded for `config` — see the 2026-09-01 amendment below.** The three rules above still
> describe `capabilities` exactly. `config` no longer replaces on an explicit value.

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

## Amendment 2026-09-01 — `config` is a top-level PATCH, not a replacement

Preserving `config` only when it is OMITTED turned out to be too narrow. It protected the
status-only and name-only flows this design was written for, but not an edit FORM that renders a
subset of the config and rebuilds the whole object from the fields it owns.

The data-source bridge kinds (`data-source:sql-readonly`, `data-source:sql-write-gated`) are
exactly that: the picker serialises `{ dataSourceId, object }`, so a rename replaced the stored
config with those two keys and destroyed `config.schema` — the connection's default SQL schema,
which the readonly source adapter reads to list objects and to qualify a bare object name. The
connection kept working; its reads silently retargeted to the server's default schema. An API
caller that did not restate the pointer likewise erased `config.dataSourceId` and the
`config.dataSourceOwnerId` stamp the core delete guard counts.

The `config` rules are now:

- omitted `config`: preserve the stored config verbatim (unchanged)
- key absent from a supplied `config`: inherit the stored value
- key present in a supplied `config`: replace that key (nested values replace whole — top level
  only, so an admin narrowing `lookupProjection` gets what they sent, not a union with stale
  sub-keys)
- explicit `{ key: null }`: the one and only way to clear a config key
- explicit `{}`: an empty patch, therefore a no-op — it no longer wipes the stored config

`capabilities` is unchanged: a supplied value still replaces wholesale.

Two invariants ride along, both tested:

- `config.dataSourceOwnerId` is server-owned. It is stripped from every incoming payload at the
  normalize choke point, so a merge can never let a client overwrite the stored stamp.
- The P2-A binding check keys off the PAYLOAD, not the merged result. A payload that asserts
  `dataSourceId` is validated against the authenticated principal and re-stamped as before; a
  payload silent about it inherits the stored pointer and stamp without re-validating — the same
  trust level as an update that omits `config` entirely.

Callers that used omission to mean "clear" had to start saying `null`. The audited set was small:
the bridge picker's `object`, and `config.healthPath` / `config.port` in
`buildK3WiseSetupPayloads`.

### Amended files

- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/__tests__/external-systems.test.cjs`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/components/integration/IntegrationConnectionSection.vue`
