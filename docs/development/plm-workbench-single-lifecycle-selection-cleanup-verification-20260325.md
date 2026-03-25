# PLM Workbench Single Lifecycle Selection Cleanup Verification

Date: 2026-03-25

## Problem confirmation

这轮确认的缺口是：

- single `Delete` / `Archive` current team view 会清 route owner
- 但不会清掉同 id 的 batch selection
- 页面会继续显示 stale 的“已选 1 项”

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

- single `Delete` current target 后，selection 会清掉该 id
- single `Archive` current target 后，selection 会清掉该 id
- 清理 selection 不影响 route owner、form draft 和 lifecycle result 本身
