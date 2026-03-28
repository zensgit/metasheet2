# PLM Workbench Team View Route Removal Verification

## Scope

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmHydratedTeamViewOwnerTakeover.ts`
- `apps/web/tests/plmHydratedTeamViewOwnerTakeover.spec.ts`

## Checks

1. 当 route query 删除 `workbenchTeamView / documentTeamView / cadTeamView / approvalsTeamView` 时，旧 in-memory team view owner 会被立即消费掉。
2. 若本地 selector 仍指向被移除的 owner，则 selector / drafts / selection 一起清掉。
3. 若用户已经切到另一个 pending selector，则只清 route owner，不误清 pending 管理态。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmHydratedTeamViewOwnerTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
