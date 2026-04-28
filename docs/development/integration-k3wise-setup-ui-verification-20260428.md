# K3 WISE Setup UI Verification - 2026-04-28

## Scope

Verifies the K3 WISE setup page and the backend credential-read seam needed for `testConnection`.

Changed files:

- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/__tests__/external-systems.test.cjs`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/router/types.ts`
- `apps/web/src/App.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Commands Run

```bash
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
```

Result: PASS.

Evidence:

```text
✓ external-systems: registry + credential boundary tests passed
```

```bash
/Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/vitest run apps/web/tests/k3WiseSetup.spec.ts --watch=false
```

Result: PASS.

Evidence:

```text
✓ apps/web/tests/k3WiseSetup.spec.ts (5 tests)
Test Files  1 passed (1)
Tests       5 passed (5)
```

```bash
/Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck apps/web/src/services/integration/k3WiseSetup.ts
```

Result: PASS.

```bash
node -e "<@vue/compiler-sfc parse + compileScript + compileTemplate for apps/web/src/views/IntegrationK3WiseSetupView.vue>"
```

Result: PASS.

Evidence:

```text
SFC compile ok
```

## Assertions Covered

- Public external-system rows remain redaction-safe.
- Adapter-only external-system load decrypts JSON credentials.
- Adapter-only load does not expose ciphertext or public credential fingerprint fields.
- WebAPI payload construction maps form fields to `erp:k3-wise-webapi`.
- SQL Server payload construction maps allowlists and middle tables to `erp:k3-wise-sqlserver`.
- Existing credential storage is preserved when a user edits config without entering replacement secret fields.
- Absolute endpoint URLs are rejected; endpoint fields must stay relative to `baseUrl`.

## Known Local Validation Limit

`vue-tsc -b apps/web/tsconfig.app.json` was attempted with the local Node 24 runtime and the dependency tree from the main checkout. It failed inside Volar before reporting project diagnostics:

```text
TypeError: Cannot read properties of undefined (reading 'fileName')
    at @volar/typescript/lib/node/decorateProgram.js
```

This was not a TypeScript error from the changed files. A targeted service TypeScript check and Vue SFC parse/compile check were run instead. CI should run the normal Node 18/20 frontend gates on a clean dependency install.
