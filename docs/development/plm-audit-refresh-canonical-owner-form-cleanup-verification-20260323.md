# PLM Audit Refresh Canonical Owner Form Cleanup Verification

## Scope

Verify that refresh-driven team-view removals clear management form drafts when the removed owner came from canonical route/follow-up ownership, not only from the local selector.

## Focused Checks

### Ownership trim helper

`apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

- clears stale drafts when the canonical management owner disappears while the local selector is empty
- keeps create-mode drafts when no managed owner exists
- keeps local-selector drafts when only a different canonical owner disappears

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `6` tests passed
- full PLM/frontend Vitest: `46` files / `289` tests passed
