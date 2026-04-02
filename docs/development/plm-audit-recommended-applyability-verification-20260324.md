# PLM Audit Recommended Applyability Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "In /Users/huazhou/Downloads/Github/metasheet2-plm-workbench, confirm whether commit 6ac548b08 still leaves recommended team-view apply actions ungated by canApply. Return only bullet points with exact file:line evidence."
```

Result:

- `Claude Code` 明确指出推荐卡 `apply` 仍绕过 `canApply`
- 证据落在 `PlmAuditView.vue` 推荐按钮/handler 和 `plmAuditTeamViewCatalog.ts` 的 recommendation builder

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCatalog.spec.ts tests/plmAuditTeamViewRouteState.spec.ts
```

Result:

- `2` files passed
- `18` tests passed

Note:

- Vitest 打印过一次 `WebSocket server error: Port is already in use`
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
- `326` tests passed

## Assertions locked by this round

- 推荐卡主按钮的可点击性现在和 `canApply` 合同一致，不再只看目标 id 是否存在。
- `applyRecommendedAuditTeamView(...)` 不会再把只读 team view 当成可应用目标。
- `applyAuditTeamViewEntry(...)` 自身也有 defensive `canApply` gate，避免未来新入口回归。
- 推荐 catalog 会显式暴露 `primaryActionDisabled`，消费者不再需要猜测主操作是否可执行。
