# PLM Workbench Transfer Selection Cleanup Verification

Date: 2026-03-25

## Problem confirmation

这轮确认的缺口是：

- `transferTeamView()` 成功后，当前视角已经转成只读
- 但本地 batch selection 仍然保留这个 id
- 页面继续显示 stale 的“已选 N 项”

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

- 转移成功且目标变只读时，会把该 id 从 batch selection 里移除
- 其它仍然有效的选中项保持不变
- route / applied state 仍继续指向被转移后的当前视角
