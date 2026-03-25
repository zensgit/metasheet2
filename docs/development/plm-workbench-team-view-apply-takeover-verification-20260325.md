# PLM Workbench Team View Apply Takeover Verification

Date: 2026-03-25

## Problem confirmation

这轮确认了两条真实 user-visible 缺口：

- pending selector drift 下，readonly canonical target 的 management controls 会被临时 selector 错误重新显示
- 应用新的 workbench team view 后，旧 batch selection 仍然保留，批量按钮继续指向上一批视角

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `38` tests passed

## Type-check

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- Passed

## Full PLM frontend regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `48` files passed
- `349` tests passed

## Assertions locked by this round

- pending selector drift 下，readonly canonical target 继续隐藏 management controls
- 同一时刻 `Apply` / `Duplicate` 仍然跟 selector target 保持可用
- `applyTeamView()` 会在成功应用前清掉旧 batch selection
- 清理 batch selection 后，`requestedViewId` 和 applied state 仍然同步到新 target
