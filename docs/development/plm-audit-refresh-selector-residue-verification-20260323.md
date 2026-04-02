# PLM Audit Refresh Selector Residue Verification

## Scope

Verify that refresh-driven team-view removals clear not only transient ownership, but also the stale local selector/focus state tied to removed team views.

## Focused Checks

### Refresh trim helper

`apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

- detects removed team-view ids
- prunes transient ownership for removed ids
- clears stale `selectedTeamViewId` and focus when the backing view disappears

### Canonical control guardrails

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- canonical management target still resolves from route/follow-up ownership

`apps/web/tests/usePlmCollaborativePermissions.spec.ts`

- `canApply` still follows the canonical control target

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts tests/usePlmCollaborativePermissions.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: pass
- focused Vitest: `3` files, `12` tests passed
- full PLM/frontend Vitest: `46` files, `284` tests passed
