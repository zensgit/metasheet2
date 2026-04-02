# PLM Audit Scene Followup Anchor Sync Verification

Date: 2026-03-23

## Scope

Verify that `scene-context` collaboration followups re-resolve their source anchor against the current page state instead of keeping a stale scene banner target.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` compiles after followups switch to a synced read path
- the new helper integrates cleanly with existing collaboration types

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditSavedViewAttention.spec.ts
```

Expected:

- scene followups retarget from `plm-audit-scene-context` to `plm-audit-team-view-controls` when the scene banner is unavailable
- saved-view attention regressions remain green alongside the new followup sync logic

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. `focus-source` from a scene-driven followup never scrolls to a dead scene banner anchor
2. scene-driven followup notice copy switches to the team-view-controls fallback when needed
3. recommendation and saved-view-promotion followups remain unchanged
