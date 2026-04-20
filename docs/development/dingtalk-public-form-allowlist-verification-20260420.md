# DingTalk Public Form Allowlist Verification

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`

## Commands run

### Backend targeted tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/integration/public-form-flow.test.ts --watch=false
```

Result:

- `28 passed`

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/public-multitable-form.spec.ts tests/multitable-form-share-manager.spec.ts --watch=false
```

Result:

- `16 passed`

Notes:

- jsdom still prints `Not implemented: navigation to another Document` during the DingTalk sign-in redirect test
- the test still passes; it asserts the redirect bootstrap state instead of full browser navigation

### Backend build

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed

Notes:

- existing Vite chunk-size warnings remain
- existing dynamic import warning for `WorkflowDesigner.vue` remains

## Verified behavior

- protected public forms can now restrict submission to selected local users
- protected public forms can now restrict submission to selected local member groups
- DingTalk still acts only as sign-in and delivery; the access subject remains the local user
- users outside the allowlist receive `DINGTALK_FORM_NOT_ALLOWED`
- form-share config returns allowlist IDs and resolved summaries to the management UI
- the management UI can search and add local users/member groups without calling admin-only APIs
- switching a protected allowlisted form back to fully public is blocked until the allowlist is cleared

## Not included

- no new database migration
- no remote deployment in this branch yet
- local `plugins/**/node_modules` and `tools/cli/node_modules` noise was not included in the feature scope
