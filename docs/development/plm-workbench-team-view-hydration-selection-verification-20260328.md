# PLM Workbench team-view hydration selection verification

## Scope

- `apps/web/src/views/plm/plmHydratedTeamViewOwnerTakeover.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmHydratedTeamViewOwnerTakeover.spec.ts`

## Checks

1. Hydration `A -> B` clears stale selector drafts and trims batch selection to `B`.
2. Hydration `A -> none` removes `A` from batch selection even when the local selector already points at another target.
3. Same-owner hydration keeps valid selector/draft/selection intact.

## Validation commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmHydratedTeamViewOwnerTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
