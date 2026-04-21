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
