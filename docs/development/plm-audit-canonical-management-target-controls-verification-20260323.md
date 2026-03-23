# PLM Audit Canonical Management Target Controls Verification

## Scope

Verify that generic team-view controls continue to target the canonical owner when `PLM Audit` pivots into follow-up/log routes that clear the local selector.

## Focused Checks

### Helper coverage

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- resolves canonical management target id from route owner first
- falls back to follow-up owner when the selector is cleared
- still locks management actions when the selector drifts from the canonical owner

### Existing behavior guardrails

`apps/web/tests/usePlmCollaborativePermissions.spec.ts`

- `canApply` stays available for a live canonical follow-up target
- `canApply` drops once that target becomes non-applicable

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

- follow-up ownership and dismissal behavior still hold

`apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

- shared-entry ownership logic still resolves actions against the right entry

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/usePlmCollaborativePermissions.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: pass
- focused Vitest: `4` files, `58` tests passed
- full PLM/frontend Vitest: `46` files, `282` tests passed
