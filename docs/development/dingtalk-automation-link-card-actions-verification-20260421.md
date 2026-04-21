# DingTalk Automation Link Card Actions Verification 2026-04-21

## Local Environment

- Worktree: `.worktrees/dingtalk-automation-link-card-actions-20260421`
- Base: `codex/dingtalk-automation-link-summary-20260421`
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
Tests       65 passed (65)

MetaAutomationManager + MetaAutomationRuleEditor
Test Files  2 passed (2)
Tests       119 passed (119)

Frontend build
passed

git diff --check
passed
```

## Covered Cases

- V1 多动作钉钉群规则列表展示公开表单与内部处理摘要。
- 钉钉群规则卡片渲染 `Open public form: Public Form` 链接。
- 公开表单链接包含 `/multitable/public-form/sheet_1/view_form?publicToken=pub_view_form`。
- 公开表单链接使用新窗口打开。
- 钉钉群规则卡片渲染 `Open internal view: Grid` 按钮。
- 点击内部处理按钮后触发 `router.push({ name: AppRouteNames.MULTITABLE, params: { sheetId, viewId } })`。
- 当公开表单缺失 `publicToken` 时，不渲染公开表单可点击入口。

## Notes

- `pnpm install --frozen-lockfile` 会在当前 worktree 下恢复 workspace 依赖，并可能让若干已跟踪的插件 `node_modules` 软链显示为 modified；这些不是本功能变更，不应纳入提交。
- `pnpm --filter @metasheet/web build` 通过，但仍有仓库既有 Vite dynamic import/chunk size 警告，和本次变更无关。
