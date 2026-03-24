# PLM Workbench Scene Applyability Gating Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "In /Users/huazhou/Downloads/Github/metasheet2-plm-workbench after commit 8bdc93eac, inspect the workbench scene primary apply path. Is there still a real canApply/actionability mismatch where the recommendation card apply button can be clicked even though the underlying team view would fail canApply gating or no-op in the handler chain? Cite exact file:line evidence and minimal fix direction."
```

Result:

- `Claude Code` 明确确认 workbench scene recommendation primary `Apply` 仍缺 `canApply` 合同
- 它同时指出 `PlmProductPanel.vue`、`plmWorkbenchSceneCatalog.ts`、`PlmProductView.vue` 和 `usePlmTeamViews.ts` 四层都存在缺口

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchSceneCatalog.spec.ts tests/usePlmProductPanel.spec.ts tests/usePlmTeamViews.spec.ts tests/usePlmCollaborativePermissions.spec.ts
```

Result:

- `4` files passed
- `37` tests passed

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
- `330` tests passed

## Assertions locked by this round

- workbench scene recommendation model 现在会显式暴露 `primaryActionDisabled`
- recommendation primary button 不再在不可 apply 时保持可点
- `applyRecommendedWorkbenchScene(...)` 和 `usePlmTeamViews.applyTeamView()` 都会对齐共享 `canApply` 合同
- selector path 和 recommendation path 的最终 apply 语义已经统一
