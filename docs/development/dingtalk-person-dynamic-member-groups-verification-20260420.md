# DingTalk Person Dynamic Member Groups Verification

Date: 2026-04-20

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Backend tests: `104 passed`
- Frontend tests: `52 passed`
- Backend build: passed
- Web build: passed
- `git diff --check`: passed

## Focus Checks

- `send_dingtalk_person_message` can resolve member-group IDs from record data
- Static and dynamic member-group IDs merge before validation and expansion
- Expanded member-group users merge with:
  - static `userIds`
  - static `memberGroupIds`
  - dynamic record user fields
- Empty dynamic member-group paths fail with a specific `member group record field paths` error
- Both automation editors can:
  - save rules that only use dynamic member-group field paths
  - hydrate existing `memberGroupIdFieldPath(s)` config
  - show `Record member groups` in summary

## Notes

- `pnpm install` updated several `plugins/**/node_modules` and `tools/cli/node_modules` paths in this worktree.
- Those dependency noise changes are not part of the feature and should not be committed.
- Frontend Vitest printed the existing `WebSocket server error: Port is already in use` warning, but the test run still completed successfully.
