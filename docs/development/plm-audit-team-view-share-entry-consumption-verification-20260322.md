# PLM Audit Team-View Share-Entry Consumption Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that shared-link entry cleanup now consumes the transient `auditEntry=share` marker on explicit exit paths, and that the local notice clears when the route no longer carries that marker.

## Focused Checks

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run \
  tests/plmAuditTeamViewShareEntry.spec.ts \
  tests/plmAuditTeamViewCollaboration.spec.ts
```

Focused behavior:

- shared-link entry reducer clears when route query no longer contains `auditEntry=share`
- shared-link entry cleanup still works for explicit filter navigation
- collaboration followup cleanup behavior from the previous shared-entry takeover slice remains intact

## Full PLM Frontend Regression

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - `2` files, `33` tests passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `43` files, `242` tests passed

## Notes

- This slice is frontend-only.
- No browser-level regression was rerun because the change is limited to transient query consumption plus the PLM frontend regression suite.
