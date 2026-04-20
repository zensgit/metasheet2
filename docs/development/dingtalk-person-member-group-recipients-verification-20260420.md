# DingTalk Person Member Group Recipients Verification

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

- Backend tests: `101 passed`
- Frontend tests: `50 passed`
- Backend build: passed
- Web build: passed
- `git diff --check`: passed

## Focus Checks

- `send_dingtalk_person_message` can target static member groups
- Member groups resolve to active local users before DingTalk delivery
- Member-group users merge with:
  - static `userIds`
  - dynamic record recipient fields
- Manager-side editors can:
  - search users and member groups together
  - add member groups from suggestions
  - persist `memberGroupIds`
  - render/removes member-group chips
  - save rules that use only member groups

## Notes

- `pnpm install` updated several `plugins/**/node_modules` and `tools/cli/node_modules` paths in the worktree.
- Those dependency noise changes are not part of the feature and should not be committed.
