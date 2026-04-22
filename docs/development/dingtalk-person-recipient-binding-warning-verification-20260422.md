# DingTalk Person Recipient Binding Warning Verification - 2026-04-22

## Branch

- `codex/dingtalk-person-recipient-binding-warning-20260422`
- Base branch: `codex/dingtalk-person-recipient-candidate-status-20260422`

## Verification Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed. `3` test files, `148` tests.

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts --reporter=dot
```

Result: passed. `1` test file, `39` tests.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Existing Vite warnings remained:
- `WorkflowDesigner.vue` is both dynamically and statically imported.
- Several production chunks exceed the default `500 kB` warning threshold.

```bash
git diff --check
```

Result: passed.

## Covered Scenarios

- Backend form-share candidate API returns DingTalk binding, grant, and direct-delivery readiness for user candidates.
- Backend form-share candidate API returns `null` DingTalk status for member-group candidates.
- Frontend API client preserves the new DingTalk status fields during normalization.
- Inline automation form shows bound/authorized, unlinked, inactive, and member-group DingTalk recipient status.
- Advanced rule editor shows the same candidate and selected-chip status.
- Role candidates remain filtered out from DingTalk person recipient selection.
- Saved automation payload remains unchanged: local user IDs and member-group IDs only.

## Non-Blocking Observations

- The backend integration file logs an existing mocked formula dependency warning in one unrelated test, but the suite passes.
- Repository still has unrelated dirty `node_modules` files under plugins/tools. They were not touched or staged.
