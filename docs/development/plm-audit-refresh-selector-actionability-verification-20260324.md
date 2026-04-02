# PLM Audit Refresh Selector Actionability Alignment Verification

Date: 2026-03-24

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewManagement.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Result:

- `3` files passed
- `23` tests passed

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
- `321` tests passed

## Assertions locked by this round

- Refresh clears a stale local `Team views` selector when the same id survives but loses apply permission.
- Refresh drops batch-selected team views that are no longer lifecycle-selectable.
- Canonical-owner form drafts continue to survive after the stale local selector is cleared.
