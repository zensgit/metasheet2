# PLM Workbench Selector Draft Cleanup Verification

Date: 2026-03-25

## Parallel review

Explorer review concluded this was a real user-visible bug:

- selector 直接改 `teamViewKey`
- `selectedTeamView` 和 rename target 立刻切到新 view
- 旧的 `teamViewName` 草稿会残留到新目标上

The review pointed at:

- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `33` tests passed

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
- `344` tests passed

## Assertions locked by this round

- selector 从 A 切到 B 时，不再保留 A 的 rename draft
- selector 从 A 切到 B 时，不再保留 A 的 transfer-owner draft
- cleanup 以同步 flush 执行，不会反过来清掉新 target 上刚输入的 draft
