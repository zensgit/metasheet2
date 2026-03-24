# PLM Audit Refresh Management Draft Downgrade Verification

Date: 2026-03-24

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewManagement.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Result:

- `3` files passed
- `24` tests passed

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
- `322` tests passed

## Assertions locked by this round

- Refresh downgrades stale management-owned name drafts into create-mode drafts when the canonical owner becomes read-only.
- Local-selector-owned drafts still survive when the selected team view remains valid.
- Actionability-based selector and batch-selection trimming continues to hold.
