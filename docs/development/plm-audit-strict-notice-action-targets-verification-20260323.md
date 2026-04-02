# PLM Audit Strict Notice Action Targets Verification

## Scope

Verify that collaboration and shared-entry notice actions stay bound to their canonical notice target and do not fall back to the local selector when that target is missing.

## Focused Checks

### Collaboration target resolution

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- collaboration notice actions stay pinned to the draft target
- missing draft targets return `null` instead of retargeting the selected team view

### Shared-entry target resolution

`apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

- shared-entry notice actions stay pinned to the entry target
- missing entry targets return `null` instead of retargeting the selected team view

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: pass
- focused Vitest: `2` files, `50` tests passed
- full PLM/frontend Vitest: `46` files, `284` tests passed
