# DingTalk Person Member Group Field Warnings Verification

Date: 2026-04-21

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Frontend tests: `58 passed`
- Web build: passed
- `git diff --check`: passed

## Focus Checks

- Rule editor warns when a member-group recipient path points at an unknown field
- Rule editor warns when a member-group recipient path points at a `user` field
- Inline automation manager shows the same two warnings
- Existing freeform `record.<fieldId>` editing continues to work
- No runtime payload shape changed

## Notes

- `pnpm install` updated several `plugins/**/node_modules` and `tools/cli/node_modules` paths in this worktree.
- Those dependency noise changes are not part of the feature and should not be committed.
