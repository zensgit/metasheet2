# PLM Audit Refresh-Removed Team View Ownership Verification

## Scope

Verify that refresh-driven team-view removals clear stale collaboration/share-entry ownership and no longer leave an invisible canonical owner in `PLM Audit`.

## Focused Checks

### Ownership diffing and pruning

`apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

- detects ids removed by a refresh
- prunes collaboration draft ownership for removed views
- prunes shared-entry ownership for removed views
- preserves unrelated follow-up ownership

### Existing collaboration/share-entry invariants

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- removed-view pruning still clears follow-up ownership for locally deleted views

`apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

- shared-entry ownership still clears when its owning view disappears

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: pass
- focused Vitest: `3` files, `51` tests passed
- full PLM/frontend Vitest: `46` files, `282` tests passed
