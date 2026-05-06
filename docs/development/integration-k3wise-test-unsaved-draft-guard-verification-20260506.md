# K3 WISE Saved-Draft Test Guard Verification - 2026-05-06

## Scope

Verified that the K3 WISE setup page does not allow connection tests against stale persisted WebAPI or SQL Server systems after local unsaved connection edits.

Changed files:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `docs/development/integration-k3wise-test-unsaved-draft-guard-development-20260506.md`
- `docs/development/integration-k3wise-test-unsaved-draft-guard-verification-20260506.md`

## Checks

### Backend Route Contract

Command:

```bash
node --test plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result:

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

Coverage added:

- A missing external system returns `404`.
- The test route ignores unsaved draft config and credentials in the request body.
- No adapter is instantiated for a missing saved system.
- No connection test or status upsert runs.

### Focused Frontend Helper Test

Command:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
```

Expected result:

```text
tests/k3WiseSetup.spec.ts: 22 tests passed
```

Coverage added:

- WebAPI saved/draft fingerprints are equal after loading a saved system.
- Pipeline-only edits do not block connection testing.
- WebAPI transport edits and credential replacement drafts block testing.
- SQL Server saved/draft fingerprints are equal after loading a saved system.
- SQL channel edits and credential replacement drafts block testing.
- Loading a saved system clears credential draft fields.
- Missing selected saved systems are treated as stale.
- Empty saved `healthPath` stays empty instead of falling back to the default health endpoint.

### Frontend Type Check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

```text
passed
```

### Diff Hygiene

Command:

```bash
git diff --check
```

Expected result:

```text
passed
```

## Live Validation

This change does not require live K3 WISE access. It guards the operator setup page and pins the plugin route contract locally. Live ERP validation remains dependent on the customer GATE packet and saved external-system credentials.
