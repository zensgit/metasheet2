# Integration Core External Systems Registry Design — 2026-04-24

## Context

`plugin-integration-core` now has a host-backed credential store that writes new secrets through `context.services.security` using the platform `enc:` format while retaining legacy `v1:` reads.

The next M1 seam is to persist external PLM/ERP/DB system definitions in the `integration_external_systems` table from migration 057. This gives later pipeline-runner slices a concrete source/target registry without exposing credentials over plugin communication.

## Decision

Add `plugins/plugin-integration-core/lib/external-systems.cjs`.

The registry is deliberately narrow:

- It uses only the structured `db.cjs` CRUD helper.
- It only touches `integration_external_systems`.
- It encrypts incoming `credentials` via `credentialStore.encrypt()`.
- It never returns plaintext credentials or `credentials_encrypted`.
- Public rows expose `hasCredentials`, `credentialFormat`, and `credentialFingerprint` only.

## Communication API

`index.cjs` now creates the registry during `activate(context)`:

```js
const db = createDb({ database: context.api.database, logger })
externalSystemRegistry = createExternalSystemRegistry({ db, credentialStore })
```

The `integration-core` namespace exposes:

```js
upsertExternalSystem(input)
getExternalSystem(input)
listExternalSystems(input)
```

`getStatus()` now includes:

```json
{
  "externalSystems": true
}
```

## Input Shape

Minimum supported input:

```ts
{
  id?: string
  tenantId: string
  workspaceId?: string | null
  projectId?: string | null
  name: string
  kind: string
  role?: 'source' | 'target' | 'bidirectional'
  config?: Record<string, unknown>
  credentials?: string | Record<string, unknown> | null
  capabilities?: Record<string, unknown>
  status?: 'active' | 'inactive' | 'error'
}
```

Rules:

- `workspaceId === ''` is normalized to `null`, matching the migration's `COALESCE(workspace_id, '')` uniqueness convention.
- `role` defaults to `source`.
- `status` defaults to `inactive`.
- `config` and `capabilities` default to `{}`.
- `credentials === undefined` preserves an existing credential on update.
- `credentials === null` clears the stored credential.
- Plain object credentials are JSON-stringified before encryption.
- Credential arrays, dates, booleans, numbers, and other non-plain-object values
  are rejected before encryption so accidental input shapes do not get silently
  persisted.

## Public Output

Returned rows use camelCase metadata and safe credential indicators:

```json
{
  "id": "sys_1",
  "tenantId": "tenant_1",
  "workspaceId": null,
  "name": "K3 WISE",
  "kind": "erp:k3-wise-webapi",
  "hasCredentials": true,
  "credentialFormat": "enc",
  "credentialFingerprint": "..."
}
```

No API in this slice returns decrypted credentials.

`credentialFormat` is derived from the stored ciphertext prefix and is intentionally coarse:

- `enc` means the value was written by the host-backed platform security service.
- `v1` means the row still contains a legacy plugin-local credential value.
- `null` means no credential is stored or the stored value has an unrecognized
  prefix. Unknown encrypted payload prefixes are intentionally not surfaced as a
  third public state.

## Trade-Offs

This slice uses `selectOne -> insertOne/updateRow` instead of a database-native upsert because `db.cjs` intentionally has no raw SQL escape hatch and no scoped `upsert` primitive yet.

That means concurrent same-scope same-name creates can race and rely on the database unique index to reject one writer. This is acceptable for the current seam. If external system registration becomes high-traffic or user-facing, add a validated `upsertByUnique()` helper to `db.cjs` rather than introducing raw SQL.

The update path treats an empty `db.updateRow()` result as a lost-update race
and throws `ExternalSystemNotFoundError` instead of returning an optimistic
success shape.

## Deferred

- REST routes and UI for external system management.
- Credential test/connect flows.
- Decrypted credential handoff to concrete adapters.
- Atomic DB-level upsert helper.
- Bulk re-encryption of legacy `v1:` credentials.
