# DingTalk Form Share Guidance Verification

Date: 2026-04-21

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "dingtalk-admin-operations-guide-20260420|DingTalk Admin|DingTalk forms and notifications|Allowed system users and member groups|No local user allowlist|Quick entry|Scenario 2" README.md docs/INDEX.md docs/dingtalk-admin-operations-guide-20260420.md apps/web/src/multitable/components/MetaFormShareManager.vue apps/web/tests/multitable-form-share-manager.spec.ts
git diff --check
```

## Results

- `tests/multitable-form-share-manager.spec.ts`: passed, 14 tests.
- `pnpm --filter @metasheet/web build`: passed.
- Documentation and frontend guidance search: passed.
- `git diff --check`: passed.

## Observations

- An initial test assertion attempted to find the search placeholder in `document.body.textContent`; the test was corrected to assert the input `placeholder` attribute instead.
- Vite build retained existing warnings about mixed dynamic/static import of `WorkflowDesigner.vue` and chunks larger than 500 kB. These are unrelated to this DingTalk form-share guidance change.
- Local tracked `node_modules` symlink dirtiness from PNPM install remains unstaged.
