# K3 WISE Saved-Draft Test Guard Development - 2026-05-06

## Goal

Prevent the `/integrations/k3-wise` setup page from testing stale saved K3 WISE connection records after an operator edits connection fields locally but has not saved them yet.

The backend `POST /api/integration/external-systems/:id/test` route tests the persisted external system identified by `:id`. It does not accept replacement connection config or credentials from the request body. The UI therefore must make that contract explicit: if the visible WebAPI or SQL Server connection draft no longer matches the selected saved system, connection testing is disabled until the operator saves.

## Scope

Changed files:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`

## Frontend Design

The setup helper now exposes saved-connection fingerprints for WebAPI and SQL Server configuration:

- `buildK3WiseWebApiConnectionFingerprint(form)`
- `buildK3WiseSqlConnectionFingerprint(form)`
- `buildK3WiseWebApiSystemConnectionFingerprint(system)`
- `buildK3WiseSqlSystemConnectionFingerprint(system)`

The fingerprints include only fields that affect connection testing:

- Scope: tenant, workspace, selected system id.
- WebAPI transport: version, environment, base URL, login path, health path, LCID, timeout.
- SQL Server channel: enabled flag, mode, server, database, allowed tables, middle tables, stored procedures.
- Credential state: saved `hasCredentials` plus a boolean `credentialDraftTouched`.

Credential values are intentionally excluded from the fingerprint. The page only needs to know whether a replacement credential draft exists; it must not serialize secret values into comparison snapshots.

The setup view compares the current form fingerprint with the selected saved system fingerprint:

- `hasUnsavedWebApiConnectionDraft`
- `hasUnsavedSqlConnectionDraft`
- `webApiTestDisabled`
- `sqlTestDisabled`

When a draft is dirty, the matching test button is disabled and the view shows a short inline hint telling the operator to save before testing. Handler-level guards mirror the disabled state so keyboard/scripted invocation cannot call the stale saved-system test path.

If a form still holds a saved system id but the refreshed saved-system list no longer contains that id, the page treats the draft as stale and disables testing. This covers tenant/workspace switching and deleted/inaccessible systems.

After a successful save, the page clears WebAPI and SQL Server credential replacement fields before refreshing saved systems. This keeps the visible form out of a permanently dirty state after credentials are saved, without echoing secrets back into the browser.

Loading a saved WebAPI or SQL Server system also clears credential draft fields. Optional WebAPI `healthPath` reloads as blank when the saved config omits it, preserving the operator's "skip health check" choice instead of reintroducing the default path.

## Backend Contract Pin

`http-routes.test.cjs` now includes a route-level test for the saved-system-only contract:

- `getExternalSystemForAdapter()` returns `ExternalSystemNotFoundError`.
- The request body includes a full unsaved K3 draft with config and credentials.
- The route returns `404`.
- No adapter is created.
- No connection test runs.
- No external system upsert occurs.

This prevents future changes from accidentally making `/external-systems/:id/test` consume or persist unsaved request-body drafts.

## Out Of Scope

- Adding an unsaved-draft "test without save" backend endpoint.
- Returning saved credential values to the frontend.
- Changing adapter connection semantics.
- Treating pipeline-only edits as connection-test blockers.
