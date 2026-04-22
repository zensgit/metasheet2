# DingTalk Automation Card Access Summary Verification 2026-04-21

## Local Environment

- Worktree: `.worktrees/dingtalk-automation-card-access-summary-20260421`
- Base: `codex/dingtalk-automation-link-card-actions-20260421`
- Package manager: `pnpm`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

```text
MetaAutomationManager
Test Files  1 passed (1)
Tests       67 passed (67)

MetaAutomationManager + MetaAutomationRuleEditor
Test Files  2 passed (2)
Tests       121 passed (121)

Frontend build
passed

git diff --check
passed
```

## Covered Cases

- 公开表单卡片入口旁显示 `Fully public; anyone with the link can submit`。
- 钉钉绑定用户 allowlist 模式显示 `DingTalk-bound users in allowlist can submit`。
- 钉钉授权用户 allowlist 模式显示 `Authorized DingTalk users in allowlist can submit`。
- 缺少 `publicToken` 的公开表单不渲染可点击入口。
- 内部处理入口仍走 `AppRouteNames.MULTITABLE` 导航。

## Notes

- `pnpm install --frozen-lockfile` 会在当前 worktree 下恢复 workspace 依赖，并可能让若干已跟踪的插件 `node_modules` 软链显示为 modified；这些不是本功能变更，不应纳入提交。
- `pnpm --filter @metasheet/web build` 通过，但仍有仓库既有 Vite dynamic import/chunk size 警告，和本次变更无关。

## Rebase Verification - 2026-04-22

The PR branch was rebased from the old PR #1018 base commit `4ff636c6088b5e065cd9b4741b4ad7981b17e870` to `origin/main@d62a4fe3` after PR #1018 was merged.

Commands rerun after rebase:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check origin/main...HEAD
```

Results:

- `MetaAutomationManager`: `1` file, `67` tests passed.
- `MetaAutomationManager + MetaAutomationRuleEditor`: `2` files, `121` tests passed.
- `@metasheet/web` build passed with the existing Vite warnings about `WorkflowDesigner.vue` mixed static/dynamic import and large chunks over `500 kB`.
- `git diff --check origin/main...HEAD` passed.

Notes:

- The rebase used `git rebase --onto origin/main 4ff636c6088b5e065cd9b4741b4ad7981b17e870 HEAD` so only the #1019 change was replayed on top of the merged #1018 mainline.
- The post-rebase diff remains limited to `MetaAutomationManager.vue`, `multitable-automation-manager.spec.ts`, and the two DingTalk automation card access summary notes.
- `pnpm install` produced local plugin/tool `node_modules` symlink modifications in the temporary worktree; those are generated dependency artifacts and were not staged.
