# PLM Audit Management Focus Replacement Verification

Date: 2026-03-23

## Scope

Verify that draft dismissal and recommendation refocus now replace stale lifecycle-management focus instead of leaving multiple visual anchors active.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` compiles after draft dismissal and recommendation refocus switch to shared attention helpers
- the new draft-dismiss helper integrates cleanly with the attention module

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- the saved-view attention suite proves draft dismissal clears only management focus
- the existing source-focus helper tests continue proving recommendation focus replaces stale management focus
- collaboration helper tests remain green alongside the updated dismissal/refocus wiring

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the PLM audit/workbench state-contract suite

## Behavioral Assertions

1. `recommendation -> lifecycle controls -> Done` no longer leaves the old lifecycle row highlighted
2. `saved-view promotion -> recommendation refocus` now ends with exactly one active recommendation highlight
3. explicit team-view handoffs still keep management focus only when the new handoff actually owns it
