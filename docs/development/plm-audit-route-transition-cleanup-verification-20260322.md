# PLM Audit Route-Transition Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that modeled audit route pivots now clear stale saved-view attention, and that shared-entry cleanup can still force a route replace when it needs to consume `auditEntry=share` without changing the stable audit state.

## Focused Checks

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run \
  tests/plmAuditSavedViewAttention.spec.ts \
  tests/plmAuditTeamViewShareEntry.spec.ts \
  tests/plmAuditTeamViewCollaboration.spec.ts
```

Focused behavior:

- shared-entry route-sync decision helper forces replace-only cleanup when needed
- saved-view attention reducer still clears on route-like takeover actions
- collaboration followup cleanup continues to coexist with the route-transition cleanup path

## Full PLM Frontend Regression

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - `3` files, `39` tests passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `43` files, `243` tests passed

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the change is limited to route-transition cleanup plus the PLM frontend regression suite.
