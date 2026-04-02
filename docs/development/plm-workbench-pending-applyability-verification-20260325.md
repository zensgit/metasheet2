# PLM Workbench Pending Applyability Verification

Date: 2026-03-25

## Problem confirmation

这轮复核发现上一刀留下了一个真实回归：

- pending-apply drift 下，generic management action 被正确冻结
- 但 `canApplyTeamView` 也跟着冻结
- 结果 `Apply` 按钮会被自己禁掉

这和 selector-first 的既有合同冲突。

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `36` tests passed

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
- `347` tests passed

## Assertions locked by this round

- pending-apply drift 下，`Apply` 仍然可用
- `applyTeamView()` 仍会命中 selector 当前 target
- generic management action 继续保持冻结
