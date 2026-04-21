# DingTalk Automation API Rule Contract Verification - 2026-04-21

## Environment

- Worktree: `.worktrees/dingtalk-automation-api-rule-contract-20260421`
- Branch: `codex/dingtalk-automation-api-rule-contract-20260421`
- Base: `codex/dingtalk-automation-api-rule-contract-base-20260421`
- Package manager: `pnpm`

## Commands Run

```bash
pnpm install --frozen-lockfile
```

Result: passed. Dependencies installed from the existing lockfile.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed. `1` file, `10` tests.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed. `3` files, `130` tests.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

```bash
pnpm --filter @metasheet/web build
```

Result: passed after tightening TypeScript casts in the automation rule normalizer.

```bash
git diff --check
```

Result: passed.

## Coverage Notes

- Backend now verifies a created DingTalk group automation rule returns `sheetId`, `triggerType`, `actionType`, `actionConfig`, `trigger`, `conditions`, `actions`, timestamps, and `createdBy` in camelCase.
- Frontend now verifies list responses can consume DB-shaped snake_case rows without leaking those fields into UI state.
- Frontend now verifies create responses unwrap `{ rule }` before returning to `useMultitableAutomation`.

## Residual Risk

- Full browser E2E for creating a DingTalk automation from the real manager page was not run in this worktree. The covered path validates the backend route contract, frontend client contract, and existing manager/editor unit suites.
- Build output still reports existing Vite chunk-size warnings unrelated to this change.

## Main-target cherry-pick verification

Date: 2026-04-21

The original PR branch was stacked on `codex/dingtalk-automation-api-rule-contract-base-20260421`, so this change was cherry-picked onto the latest `main` after the create-entry work landed. This avoids re-merging older DingTalk/Yjs stack commits.

- Worktree: `/private/tmp/metasheet2-dingtalk-api-contract-main`
- Branch: `codex/dingtalk-automation-api-rule-contract-main-20260421`
- Base: `c1dae37f9e9d2c96651f6e40f68baebaa2e02c72`
- Cherry-picked source commit: `818bab3bdc3240ece9e1b748815570c7ef200e09`
- Main-target commit: `14c0b0619`

Commands rerun after the cherry-pick:

```bash
pnpm install --frozen-lockfile
```

Result: passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed.

Summary:

- `tests/integration/dingtalk-automation-link-routes.api.test.ts`: 10 tests passed.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed.

Summary:

- `tests/multitable-client.spec.ts`: 14 tests passed.
- `tests/multitable-automation-manager.spec.ts`: 62 tests passed.
- `tests/multitable-automation-rule-editor.spec.ts`: 54 tests passed.
- Total: 130 tests passed.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

```bash
pnpm --filter @metasheet/web build
```

Result: passed.

```bash
git diff --check HEAD~1..HEAD
```

Result: passed.

Notes:

- Frontend Vitest emitted the existing WebSocket port warning.
- Backend Vitest emitted the existing Vite CJS Node API deprecation warning.
- Web build emitted existing Vite dynamic-import and chunk-size warnings.
- `pnpm install` emitted the existing ignored-build-scripts warning.
