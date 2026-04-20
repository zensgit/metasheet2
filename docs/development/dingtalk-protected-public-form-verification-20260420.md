# DingTalk Protected Public Form Verification

- Date: 2026-04-20
- Branch: `codex/dingtalk-protected-public-form-20260420`

## Commands run

### Backend targeted tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/integration/public-form-flow.test.ts tests/integration/multitable-record-form.api.test.ts --watch=false
```

Result:

- `24 passed`

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/public-multitable-form.spec.ts tests/multitable-form-share-manager.spec.ts --watch=false
```

Result:

- `12 passed`

Notes:

- jsdom prints `Not implemented: navigation to another Document` when the DingTalk sign-in launch path attempts browser navigation
- the test still passes and asserts the redirect bootstrap state instead of trying to fully emulate browser navigation

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

- public form sharing can now be authored in `public`, `dingtalk`, and `dingtalk_granted` modes
- public-form routes no longer require JWT, but now optionally hydrate the signed-in user when present
- anonymous access to DingTalk-protected forms triggers DingTalk sign-in bootstrap
- bound signed-in users can load `dingtalk` forms
- bound-but-not-granted users are rejected from `dingtalk_granted` forms
- form-share config endpoints expose and update `accessMode`

## Not included

- no new database migration
- no remote deployment in this branch yet
- local `plugins/**/node_modules` and `tools/cli/node_modules` noise was not included in the feature scope
