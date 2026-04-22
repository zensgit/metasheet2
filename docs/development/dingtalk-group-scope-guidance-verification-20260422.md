# DingTalk Group Scope Guidance Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-scope-guidance-20260422`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "data-dingtalk-groups-scope-note|Table-scoped DingTalk groups|bound to this table|add multiple groups|choose one or more in automations|one table can have multiple groups|dt_2" apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/tests/multitable-api-token-manager.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-group-scope-guidance-*.md
git diff --check
```

## Expected Coverage

- DingTalk Groups tab renders scope guidance for users who can manage automations.
- The guidance explains table-scoped binding.
- The guidance explains multi-group support for one table.
- The DingTalk Groups tab can render multiple group destination cards for the same table.
- The guidance explains automations can choose one or more groups.
- Existing DingTalk Groups happy path tests still pass.
- Frontend build verifies Vue and TypeScript integration.

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false`: passed, 1 file and 21 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `rg -n "data-dingtalk-groups-scope-note|Table-scoped DingTalk groups|bound to this table|add multiple groups|choose one or more in automations|one table can have multiple groups|dt_2" ...`: passed, expected frontend/test/doc references found.
- `git diff --check`: passed.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.117 (Claude Code)`
- A read-only `claude -p` run was attempted with `--tools ""`. It could not inspect files in its session and did not edit files.

## Rebase verification - 2026-04-22

- Rebased onto `origin/main@f5bea874b6fd` after PR #1038 was merged.
- Rebased branch HEAD: `ee117ff82d53`.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false`: passed, 1 file and 21 tests.
- `rg -n "data-dingtalk-groups-scope-note|Table-scoped DingTalk groups|bound to this table|add multiple groups|choose one or more in automations|one table can have multiple groups|dt_2" ...`: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/web build`: passed. Vite emitted only existing chunk-size and mixed static/dynamic import warnings.
