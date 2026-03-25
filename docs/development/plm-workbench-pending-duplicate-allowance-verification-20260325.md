# PLM Workbench Pending Duplicate Allowance Verification

Date: 2026-03-25

## Problem confirmation

这轮复核了 workbench 既有 benchmark 与回归约束：

- `duplicate any visible workbench view`
- duplicate 成功后切到新副本 id

因此上一轮把 `duplicate` 和 generic management 一起冻结，属于真实回归。

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `35` tests passed

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
- `346` tests passed

## Assertions locked by this round

- pending-apply drift 下，`duplicate` 不会被 generic management freeze 误伤
- selector 指向的 visible target 仍可直接 fork 成新副本
- `share / rename / delete / set-default` 等真正 management action 继续保持冻结
