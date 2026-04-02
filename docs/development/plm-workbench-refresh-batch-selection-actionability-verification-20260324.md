# PLM Workbench Refresh Batch Selection Actionability Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts and apps/web/src/components/plm/PlmTeamViewsBlock.vue in the current repo. The batch checkbox is disabled when !(view.permissions?.canManage ?? view.canManage), but refreshTeamViews() appears to retain teamViewSelection by id only. Is that a real stale-selection bug after permissions refresh? Cite exact file:line evidence and the smallest fix."
```

Result:

- `Claude Code` 用更窄的 prompt 校验了这条路径，并确认这是一条真实 stale-selection bug
- 它同时给出最小修法方向：refresh 时按当前 manageability trim `teamViewSelection`

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `27` tests passed

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
- `338` tests passed

## Assertions locked by this round

- refresh 后同 id 的只读 team view 不会继续保留旧 batch selection
- `teamViewSelectionCount` 不再把 disabled checkbox 残留算进已选数量
- batch checkbox 的 disabled 合同和 refresh trim 合同现在一致
