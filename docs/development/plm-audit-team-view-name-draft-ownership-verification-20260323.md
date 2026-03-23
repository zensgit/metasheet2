# PLM Audit Team View Name Draft Ownership Verification

## Scope

Verify that canonical owner changes no longer erase valid team-view name drafts, while stale rename submissions stay blocked.

## Focused Checks

### Form draft reducer

`apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

- preserves `draftTeamViewName` and `draftTeamViewNameOwnerId` across canonical owner changes
- still clears `draftOwnerUserId` on canonical owner changes
- keeps refresh trimming aligned with the stored name-draft owner id

### Rename submission gating

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- allows rename only when the name draft owner matches the current canonical owner
- blocks rename for preserved save drafts that no longer belong to the active owner

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `2` files / `15` tests passed
- full PLM/frontend Vitest: `46` files / `292` tests passed
