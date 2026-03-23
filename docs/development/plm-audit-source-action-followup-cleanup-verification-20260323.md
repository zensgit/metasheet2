# PLM Audit Source Action Followup Cleanup Verification

Date: 2026-03-23

## Scope

Verify that source-driven collaboration outcomes now consume stale saved-view/source attention before their followups become active.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after sourceful collaboration actions switch to the shared handoff cleanup helper

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- saved-view attention helper contract remains green
- collaboration followup contract tests remain green alongside the new cleanup call sites

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. recommendation secondary actions no longer leave stale saved-view/source attention behind
2. scene-context and saved-view-promotion sourced collaboration outcomes follow the same cleanup rule
3. generic share/default actions without provenance are unchanged
