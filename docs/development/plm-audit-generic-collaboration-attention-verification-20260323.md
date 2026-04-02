# PLM Audit Generic Collaboration Attention Verification

Date: 2026-03-23

## Scope

Verify that generic team-view actions now clear inherited source attention instead of silently reusing stale recommendation or saved-view highlights.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` compiles after generic collaboration actions switch to helper-driven attention routing
- the new attention-mode helper integrates cleanly with the collaboration module

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditSavedViewAttention.spec.ts
```

Expected:

- collaboration helper tests prove which outcomes stay in management context versus source-share followup context
- existing attention helper tests remain green alongside the updated action wiring

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the PLM audit/workbench state-contract suite

## Behavioral Assertions

1. a generic `share` no longer leaves an old recommendation or saved-view highlight behind after taking over from a source-aware flow
2. generic and default team-view actions now share one management-context cleanup rule
3. source-aware `share` still uses the stricter cleanup that clears management focus too
