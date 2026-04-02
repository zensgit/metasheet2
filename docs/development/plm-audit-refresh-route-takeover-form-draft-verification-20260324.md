# PLM Audit Refresh Route Takeover Form-Draft Verification

## Scope

验证 refresh `apply-view / clear-selection` takeovers 现在会清 management-owned form drafts，同时保留 create-mode drafts。

## Checks

- route takeover + ownership focused regressions
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewAudit.spec.ts tests/plmAuditTeamViewRouteState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `5` files / `70` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `313` tests passed

## Verified Outcome

- refresh `apply-view / clear-selection` takeovers now clear management-owned team-view form drafts together with other transient ownership
- create-mode drafts remain intact because they have no draft owner id
- route takeover cleanup stays pure and fully covered in `plmAuditTeamViewRouteTakeover.spec.ts`
