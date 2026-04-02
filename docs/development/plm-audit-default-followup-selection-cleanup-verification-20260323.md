# PLM Audit Default Followup Selection Cleanup Verification

## Scope

Verify that `set-default-followup` handoffs keep visual focus but stop carrying implicit batch selection.

## Focused Checks

### Collaboration handoff builder

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- `draft` handoffs still select the target team view
- `set-default-followup` handoffs keep focus but return `selectedIds: []`

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `35` tests passed
- full PLM/frontend Vitest: `46` files / `290` tests passed
