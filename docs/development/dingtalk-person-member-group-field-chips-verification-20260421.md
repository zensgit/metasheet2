# DingTalk Person Member Group Field Chips Verification

Date: 2026-04-21

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Frontend tests: `54 passed`
- Web build: passed
- `git diff --check`: passed

## Focus Checks

- Rule editor shows chips for dynamic member-group field paths
- Inline automation manager shows chips for dynamic member-group field paths
- Clicking a chip removes that member-group field path from the underlying text input
- Existing dynamic user-field chips continue to work unchanged
- No runtime payload shape changed

## Notes

- `pnpm install` updated several `plugins/**/node_modules` and `tools/cli/node_modules` paths in this worktree.
- Those dependency noise changes are not part of the feature and should not be committed.
