# PLM Audit Transfer Owner Target Gating Verification

## Scope

Verify that transfer-owner input gating follows target availability, not submit readiness.

## Focused Checks

### Permission model

`apps/web/tests/usePlmCollaborativePermissions.spec.ts`

- keeps `canTransferTarget` true for a transferable target even when the draft is blank
- keeps `canTransfer` false until the user types a different owner id
- disables both once the target itself is no longer transferable

### Input gating helper

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- disables transfer-owner input only when the target is locked, unavailable, or loading

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts tests/usePlmCollaborativePermissions.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `2` files / `10` tests passed
- full PLM/frontend Vitest: `46` files / `290` tests passed
