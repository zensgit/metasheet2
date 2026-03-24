# PLM Audit Refresh Route Applyability Verification

Date: 2026-03-24

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewRouteState.spec.ts tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewManagement.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Result:

- `4` files passed
- `35` tests passed

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
- `324` tests passed

## Assertions locked by this round

- Refresh clears explicit route ownership when the requested team view still exists but is no longer apply-able.
- Default team-view fallback skips non-applicable defaults instead of re-owning the route.
- Selector/actionability and management-draft cleanup from the previous rounds continue to hold.
