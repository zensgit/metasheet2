# Integration Core External Systems Registry Verification — 2026-04-24

## Scope

Verify the M1 external-system registry seam for `plugin-integration-core`:

- Registry persists external system metadata through the scoped DB helper.
- Credential writes go through the host-backed credential store.
- Public reads do not leak plaintext credentials or ciphertext.
- Runtime communication exposes registry methods.

## Commands Run

```bash
pnpm -F plugin-integration-core test
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
node --import tsx scripts/validate-plugin-manifests.ts
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/plugin-runtime-security.test.ts \
  tests/unit/plugin-runtime-teardown.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Results

- `plugin-integration-core` package tests: passed.
- `external-systems.test.cjs`: passed.
- Plugin manifest validation: 13 valid, 0 invalid. Existing warnings remain in unrelated plugins.
- Runtime security/teardown focused backend tests: 2 files, 6 tests passed.
- Backend `tsc --noEmit`: passed.

## Covered Behaviors

- `upsertExternalSystem()` validates required tenant/name/kind fields.
- `role` rejects values outside `source | target | bidirectional`.
- `status` rejects values outside `active | inactive | error`.
- `credentials` accepts only string, plain object, `null`, or `undefined`.
- Credential arrays, dates, booleans, and numbers are rejected before encryption.
- New rows encrypt `credentials` and store only `credentials_encrypted`.
- Public result never contains plaintext credentials.
- Public result never contains `credentials_encrypted`.
- Public result exposes only coarse credential metadata: `hasCredentials`, `credentialFormat`, and `credentialFingerprint`.
- Unknown stored credential prefixes map to `credentialFormat: null` rather than
  adding an undocumented public format.
- Updating without `credentials` preserves the stored credential.
- Updating with `credentials: null` clears the stored credential.
- A missing `db.select()` helper is rejected at registry construction because
  `listExternalSystems()` requires it.
- An empty `db.updateRow()` result during update throws
  `ExternalSystemNotFoundError` instead of returning an optimistic success row.
- `getExternalSystem()` returns safe public shape and throws `ExternalSystemNotFoundError` when absent.
- `listExternalSystems()` scopes by tenant/workspace and supports `kind` filtering.
- `workspaceId` scoping keeps `null` and another workspace isolated.
- Plugin runtime smoke verifies the communication API exposes `upsertExternalSystem`, `getExternalSystem`, and `listExternalSystems`.
- Host-loader smoke verifies `getStatus().externalSystems === true`.

## Not Covered

- Live Postgres execution of migration 057 in this local run.
- REST authz, because this slice exposes only plugin communication methods.
- Atomic concurrent same-name upsert. The current implementation relies on the DB unique index for race rejection.
