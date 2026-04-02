# PLM Workbench Owner Draft Targeting Verification

Date: 2026-03-24

## Parallel review

This round started with parallel code inspection of:

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

Conclusion:

- `teamViewOwnerUserId` 的 cleanup 已覆盖“失去选择/失去 manageability”
- 但没有覆盖“切到另一条 view”或“从 create-mode 保存新 view”
- 这是更直接的 stale owner-draft targeting bug

## Claude Code status

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude auth status
/Users/huazhou/.local/bin/claude -p "Inspect usePlmTeamViews.ts after commit 173a5b825 for the next high-confidence bug."
```

Result:

- `Claude Code` 登录态正常
- 本轮 prompt 在返回结论前命中了当日额度上限
- 这次 fix 因此基于本地并行代码核对完成

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `32` tests passed

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
- `343` tests passed

## Assertions locked by this round

- `duplicateTeamView()` 不会再把旧 transfer-owner draft 带进复制后的新 view
- `saveTeamView()` 不会再把 create-mode stray owner draft 带进新保存的 team view
- owner draft cleanup 继续与“当前管理目标”绑定，而不是与页面全局状态绑定
