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

## Rebase Verification - 2026-04-22

- Previous stack base: `e1789d8a4e3d8b4658f61447f8b986e18573c561`
- New base: `origin/main@6cd6bc3da4eb607cbb0718ac57cbf0e15147d578`
- Rebase command: `git rebase --onto origin/main origin/codex/dingtalk-form-share-guidance-base-20260421 HEAD`
- Result: clean rebase, no conflicts.

Commands rerun after rebase:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
rg -n "dingtalk-admin-operations-guide-20260420|DingTalk Admin|DingTalk forms and notifications|Allowed system users and member groups|No local user allowlist|Quick entry|Scenario 2" README.md docs/INDEX.md docs/dingtalk-admin-operations-guide-20260420.md apps/web/src/multitable/components/MetaFormShareManager.vue apps/web/tests/multitable-form-share-manager.spec.ts
pnpm --filter @metasheet/web build
git diff --check
```

Results:

```text
MetaFormShareManager
Test Files  1 passed (1)
Tests       14 passed (14)

Documentation and frontend guidance search
passed

Frontend build
passed

git diff --check
passed
```

Build note: the existing `WorkflowDesigner.vue` mixed static/dynamic import warning and large chunk warning remain unchanged and unrelated to this PR.
