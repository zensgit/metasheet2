# PLM Workbench Refresh Owner Draft Cleanup Verification

Date: 2026-03-24

## Claude Code status

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude auth status
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts for the next concrete refresh/apply/manage bug."
```

Result:

- `Claude Code` 当前处于登录态
- 本轮进一步只读调用时命中了当日额度上限，未返回新的可直接采用结论
- 这次修复因此基于本地代码核对继续完成；问题本身是与前一轮 `teamViewName` stale draft 同型的 owner-draft residue

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `29` tests passed

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
- `340` tests passed

## Assertions locked by this round

- refresh 移除当前 team view 时，不再残留旧 owner draft
- refresh 把当前 team view 降成不可 apply 时，不再残留旧 owner draft
- delete / archive / batch archive 清掉当前选中目标时，owner draft 会和 name draft 一起清空
- `teamViewName` 的 create/save 草稿语义不受这轮 owner cleanup 影响
