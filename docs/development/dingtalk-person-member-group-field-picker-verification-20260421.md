# DingTalk Person Member Group Field Picker Verification

Date: 2026-04-21

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Frontend tests: `62 passed`
- Web build: passed
- `git diff --check`: passed

## Focus Checks

- Rule editor can pick a member-group recipient field and writes `record.<fieldId>`
- Inline automation manager can pick a member-group recipient field and writes `record.<fieldId>`
- Member-group picker only lists explicit member-group fields
- Existing chips and warnings continue to work with picker-added paths
- No runtime payload shape changed

## Notes

- Web build still emits the repository's existing Vite chunk-size warning; this PR does not change chunking strategy.
- `pnpm install` updated several `plugins/**/node_modules` and `tools/cli/node_modules` paths in this worktree.
- Those dependency noise changes are not part of the feature and should not be committed.
