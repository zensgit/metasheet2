# DingTalk Group Dynamic Destinations Verification

- Date: 2026-04-21
- Target branch: `codex/dingtalk-group-dynamic-destinations-20260421`

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Backend unit tests: `106 passed`
- Frontend tests: `66 passed`
- `pnpm --filter @metasheet/core-backend build`: passed
- `pnpm --filter @metasheet/web build`: passed
- `git diff --check`: passed

## Focused Coverage Added

### Backend

`packages/core-backend/tests/unit/automation-v1.test.ts`

- `executes send_dingtalk_group_message with dynamic record destinations`
- `fails send_dingtalk_group_message when dynamic record path resolves no destinations`

### Frontend

`apps/web/tests/multitable-automation-rule-editor.spec.ts`

- emits group action config with only dynamic record destination paths
- can pick a dynamic DingTalk group destination field

`apps/web/tests/multitable-automation-manager.spec.ts`

- creates group automation with only dynamic record destination paths
- can pick a dynamic DingTalk group destination field in the inline form

## Notes

- `pnpm install` in this fresh worktree also produced local `plugins/**/node_modules` and `tools/cli/node_modules` noise, but none of those files were staged for commit.
- Frontend vitest emitted the existing `WebSocket server error: Port is already in use` line during jsdom runs; the suite still passed and this change did not introduce a new failure mode.
