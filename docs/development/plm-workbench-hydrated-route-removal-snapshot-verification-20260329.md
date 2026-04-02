# PLM Workbench Hydrated Route Removal Snapshot Verification

## Verified behavior

- Route hydration now preserves the previous hydrated owner/preset key long enough to execute `A -> none` cleanup branches.
- The shared transition resolver covers all three outcomes: `apply`, `remove`, and `noop`.
- Team view, team preset, and local preset removal paths in `PlmProductView.vue` now all consume the same snapshot-based transition contract.

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmHydratedRouteQueryTransition.spec.ts tests/plmHydratedTeamViewOwnerTakeover.spec.ts tests/plmHydratedTeamPresetOwnerTakeover.spec.ts tests/plmLocalFilterPresetRouteIdentity.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
