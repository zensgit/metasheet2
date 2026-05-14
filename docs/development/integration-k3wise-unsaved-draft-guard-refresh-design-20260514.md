# K3 WISE Unsaved Draft Test Guard Refresh Design - 2026-05-14

## Scope

Refresh stale PR #1348 on current `main`. The target gap is the K3 WISE setup page's saved-system test contract:

- `POST /api/integration/external-systems/:id/test` tests the persisted external system identified by `:id`.
- The route does not test replacement connection config or credentials from the request body.
- Therefore the UI must not allow an operator to edit connection fields locally and then test the stale saved system as if the draft were being tested.

## Design

### Saved/draft fingerprints

`apps/web/src/services/integration/k3WiseSetup.ts` now exposes fingerprint helpers:

- `buildK3WiseWebApiConnectionFingerprint(form)`
- `buildK3WiseSqlConnectionFingerprint(form)`
- `buildK3WiseWebApiSystemConnectionFingerprint(system)`
- `buildK3WiseSqlSystemConnectionFingerprint(system)`

The fingerprints include connection-test inputs only:

- scope: tenant, workspace, selected system id;
- saved credential presence plus whether credential replacement fields are currently touched;
- WebAPI: version, environment, auth mode, base URL, token/login/health paths, LCID, timeout;
- SQL Server: enabled flag, mode, server, database, allowed tables, middle tables, stored procedures.

Credential values are intentionally excluded. Only `credentialDraftTouched` is recorded;
for WebAPI this includes authority-code and login credential replacement fields.

### UI guard

`IntegrationK3WiseSetupView.vue` computes:

- `hasUnsavedWebApiConnectionDraft`
- `hasUnsavedSqlConnectionDraft`
- `webApiTestDisabled`
- `sqlTestDisabled`

The WebAPI and SQL Server test buttons are disabled when the current draft no longer matches the selected saved system. Inline hints tell the operator to save before testing. The click handlers have the same guard, so scripted or keyboard invocation cannot bypass the disabled state.

If the form still has a saved system id but the refreshed saved-system list no longer contains it, the draft is treated as stale and testing is disabled.

After a successful save or saved-system load, credential replacement fields are cleared. This prevents a newly saved credential replacement from leaving the page in a permanently dirty state without echoing secrets back into the browser.

### Backend route contract

`plugins/plugin-integration-core/__tests__/http-routes.test.cjs` now pins the saved-system-only route contract:

- missing saved system returns `404`;
- request-body draft config and credentials are ignored;
- no adapter is created;
- no connection test runs;
- no external system upsert happens.

## Boundary

This does not add a "test unsaved draft" backend endpoint. Operators must save before testing, which matches the existing persisted-system route contract.
