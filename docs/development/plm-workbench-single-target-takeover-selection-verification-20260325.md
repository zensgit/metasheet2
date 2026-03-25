# PLM Workbench Single-Target Takeover Selection Verification

Date: 2026-03-25

## Problem confirmation

这轮确认了一个明确的对称性缺口：

- `applyTeamView()` 已经会清旧 batch selection
- 但 `saveTeamView()` 和 `duplicateTeamView()` 仍然不会

因此页面虽然已经切到新 team view，批量按钮却还在操作旧选择。

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `39` tests passed

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
- `350` tests passed

## Assertions locked by this round

- `saveTeamView()` 成功后，旧 batch selection 被清掉
- `duplicateTeamView()` 成功后，旧 batch selection 被清掉
- 清理 selection 后，`requestedViewId` 和 applied state 仍继续指向新 target
