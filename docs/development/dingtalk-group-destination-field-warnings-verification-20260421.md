# DingTalk Group Destination Field Warnings Verification

- Date: 2026-04-21
- Target branch: `codex/dingtalk-group-destination-field-warnings-20260421`

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-recipient-field-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
git diff --cached --check
```

## Results

- Frontend tests: `71 passed`
- `pnpm --filter @metasheet/web build`: passed
- `git diff --check`: passed
- `git diff --cached --check`: passed

## Focused Coverage Added

### Shared DingTalk Recipient Field Warning Utility

`apps/web/tests/dingtalk-recipient-field-warnings.spec.ts`

- parses comma/newline field paths and strips optional `record.` prefixes
- deduplicates repeated paths
- warns for unknown fields, user fields, and member-group fields
- treats `property.refKind = member-group`, `member-group`, `member_group`, and `membergroup` as member-group recipient fields
- ignores empty and non-string input

### Full Rule Editor

`apps/web/tests/multitable-automation-rule-editor.spec.ts`

- warns when a dynamic DingTalk group destination path points to a user or member group field

### Inline Automation Manager

`apps/web/tests/multitable-automation-manager.spec.ts`

- warns when a dynamic DingTalk group destination path points to a user or member group field in the inline form

## Notes

- The first test/build attempt failed because this fresh stacked worktree did not yet have `node_modules`; after `pnpm install --frozen-lockfile`, the targeted tests and web build passed.
- `pnpm --filter @metasheet/web build` still emits existing Vite warnings about large chunks and a mixed static/dynamic import for `WorkflowDesigner.vue`; the build exits successfully.
- `pnpm install` produced local `plugins/**/node_modules` and `tools/cli/node_modules` noise; those files were not staged.
