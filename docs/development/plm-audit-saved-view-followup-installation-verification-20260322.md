# PLM Audit Saved-View Followup Installation Verification

Date: 2026-03-22

## Scope

Verify that installing a fresh local saved-view followup now consumes stale source focus instead of letting old saved-view focus survive alongside the new notice.

## Focused Checks

### Reducer contract

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
```

Expected:

- `plmAuditSavedViewAttention.spec.ts` proves `install-followup` replaces older saved-view focus with the new local followup
- adjacent shared-entry regression coverage stays green

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after both local-save entry points switch to the reducer-backed install path

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions in the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. `scene-context -> Save as local view` clears stale source focus before raising the new saved-view followup
2. `shared-entry -> Save as local view` uses the same cleanup/install path
3. saved-view attention still remains reducer-owned and testable outside the page component
