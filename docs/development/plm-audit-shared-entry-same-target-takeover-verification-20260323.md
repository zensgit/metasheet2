# PLM Audit Shared Entry Same-Target Takeover Verification

## Scope

Verify that shared-entry takeover only happens when the current action target still matches the active shared-entry owner.

## Focused Checks

### Shared-entry takeover gating

`apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

- management handoff takeovers require the same target team view id
- source-aware collaboration takeovers require the same target team view id
- source-aware gating still respects `sourceAware = false`

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `15` tests passed
- full PLM/frontend Vitest: `46` files / `294` tests passed
