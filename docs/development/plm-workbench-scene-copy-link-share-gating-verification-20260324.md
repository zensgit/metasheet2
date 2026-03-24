# PLM Workbench Scene Copy-Link Share Gating Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "In /Users/huazhou/Downloads/Github/metasheet2-plm-workbench after commit 74f12281e, inspect the workbench scene recommendation copy-link path. Is there still a real canShare bypass in PlmProductView.vue / plmWorkbenchSceneCatalog.ts? Reply briefly with exact file:line evidence and the minimal fix direction."
```

Result:

- `Claude Code` 明确确认了 workbench scene recommendation 的 `copy-link` 仍然绕过 `canShare`
- 它指出 catalog、panel button 和 `copyRecommendedWorkbenchSceneLink(...)` 三层都缺 share gating

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchSceneCatalog.spec.ts tests/usePlmProductPanel.spec.ts
```

Result:

- `2` files passed
- `11` tests passed

Note:

- focused Vitest 打印过 `WebSocket server error: Port is already in use`
- 测试进程正常退出，结果全绿

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

- workbench scene recommendation 的 `copy-link` 现在会对齐 `canShare`
- scene recommendation model 现在显式暴露 `secondaryActionDisabled`
- panel button 和 `copyRecommendedWorkbenchSceneLink(...)` 都不会再绕过 share 权限
