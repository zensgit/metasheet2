# DingTalk Public Form Access Helper Tests Verification 2026-04-21

## Local Environment

- Worktree: `.worktrees/dingtalk-public-form-access-helper-tests-20260421`
- Base: `codex/dingtalk-automation-access-state-badges-20260421`
- Package manager: `pnpm`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

```text
DingTalk public form link warnings
Test Files  1 passed (1)
Tests       7 passed (7)

DingTalk public form helper + automation adjacent tests
Test Files  3 passed (3)
Tests       129 passed (129)

Frontend build
passed

git diff --check
passed
```

## Covered Cases

- `getDingTalkPublicFormLinkAccessLevel('', views)` returns `none`。
- Active public form returns `public`。
- Active DingTalk-bound forms return `dingtalk`。
- Active DingTalk-authorized forms return `dingtalk_granted`。
- Missing view, non-form view, unconfigured sharing, disabled sharing, missing token, expired sharing return `unavailable`。

## Notes

- `pnpm install --frozen-lockfile` 会在当前 worktree 下恢复 workspace 依赖，并可能让若干已跟踪的插件 `node_modules` 软链显示为 modified；这些不是本功能变更，不应纳入提交。
- `pnpm --filter @metasheet/web build` 通过，但仍有仓库既有 Vite dynamic import/chunk size 警告，和本次变更无关。
