# PLM Team Scene Audit Catalog Verification

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Changed Files

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`
- `packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts`
- `apps/web/src/services/plm/plmWorkbenchClient.ts`
- `apps/web/src/views/plmAuditQueryState.ts`
- `apps/web/src/views/plmAuditSavedViews.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plm/plmPanelModels.ts`
- `apps/web/src/views/plm/usePlmProductPanel.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/components/plm/PlmProductPanel.vue`
- `apps/web/src/components/plm/PlmPanelShared.css`
- `apps/web/tests/plmWorkbenchClient.spec.ts`
- `apps/web/tests/plmAuditQueryState.spec.ts`
- `apps/web/tests/plmAuditSavedViews.spec.ts`
- `apps/web/tests/usePlmProductPanel.spec.ts`

## Focused Validation

Passed:

- `TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-workbench-audit-routes.test.ts`
  - `2 files / 32 tests`
- `TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts tests/plmAuditSavedViews.spec.ts tests/usePlmProductPanel.spec.ts`
  - `4 files / 32 tests`

## Full Package Validation

Passed:

- `TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp pnpm --filter @metasheet/web test`
  - `33 files / 176 tests`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

## Behavioral Checks

- 设置或清除 workbench 默认团队场景会写入 `plm-team-view-default` 审计。
- 审计页可以直接按默认场景事件过滤。
- 审计 saved views 不会再丢失默认场景过滤条件。
- 产品页提供团队场景目录，支持 owner 过滤、快速应用、复制链接和跳转场景审计。
