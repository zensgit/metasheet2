# Integration Test Status Persistence Verification - 2026-04-28

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `docs/development/integration-test-status-persist-design-20260428.md`
- `docs/development/integration-test-status-persist-verification-20260428.md`

## Commands Run

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result: PASS.

Evidence:

```text
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
```

```bash
node -c plugins/plugin-integration-core/lib/http-routes.cjs
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

```bash
git diff --check
```

Result: PASS.

## Regression Assertions

The expanded `http-routes.test.cjs` covers:

- `externalSystemsTest` loads the adapter-scoped external system and keeps credentials out of the response.
- successful test persists `status: active`, `lastTestedAt`, and `lastError: null`.
- failed test persists `status: error` and a readable `lastError`.
- successful test does not activate a system that was intentionally `inactive`.

## Local Limit

This slice did not rerun the full frontend workspace type-check. The previous K3 WISE UI slice recorded that local `vue-tsc -b` fails in the current Node 24/Volar environment before project diagnostics. This slice instead uses the direct Vue SFC compile check for the touched component plus backend unit coverage for the changed route behavior.
