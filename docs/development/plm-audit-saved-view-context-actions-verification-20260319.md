# PLM Audit Saved View Context Actions Verification

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Verified Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewSummary.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSavedViewSummary.spec.ts`

## Validation Commands

### Focused

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/plmAuditSavedViewSummary.spec.ts \
  tests/plmAuditSavedViews.spec.ts
```

### Full frontend

```bash
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Behavioral Checks

- Saved-view owner-context badges now expose `Restore scene query` when appropriate.
- Saved-view scene-query badges now expose `Filter by owner` when appropriate.
- Saved-view shortcut owner badges expose `Filter by owner`.
- Saved-view cards do not expose `Clear context` as a quick action.

## Notes

- This slice is still frontend-only and route-state-only.
- No real PLM regression rerun is required because no backend, route contract, or upstream integration changed.
