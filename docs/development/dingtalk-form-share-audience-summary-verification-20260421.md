# DingTalk Form Share Audience Summary Verification

Date: 2026-04-21

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "Local allowlist limits|No local allowlist limits|data-form-share-allowlist-summary|DingTalk group roster|allowlist audience|allowedUserIds|allowedMemberGroupIds" apps/web/src/multitable/components/MetaFormShareManager.vue apps/web/tests/multitable-form-share-manager.spec.ts docs/dingtalk-admin-operations-guide-20260420.md
git diff --check
```

## Results

- `tests/multitable-form-share-manager.spec.ts`: passed, 15 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `rg` guidance/search check: passed.
- `git diff --check`: passed.

## Observations

- Vite build retained existing warnings about mixed dynamic/static import of `WorkflowDesigner.vue` and chunks larger than 500 kB. These are unrelated to this DingTalk audience-summary change.
- Local tracked `node_modules` symlink dirtiness from PNPM install remains unstaged.
