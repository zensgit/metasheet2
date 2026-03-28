# PLM Workbench Audit Team View Management Feedback Verification

Date: 2026-03-29
Commit: pending

## Scope

Verify that audit team view lifecycle/default actions no longer fail silently when the management target is missing, locked, read-only, already in a no-op state, or otherwise unavailable.

## Focused Validation

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewManagementFeedback.spec.ts tests/plmAuditTeamViewManagement.spec.ts
```

Expected coverage:

- no-target feedback
- locked-target feedback
- creator-only denial
- no-op default/lifecycle feedback
- generic unavailable actionability feedback
- proceed case returns `null`

## Type Validation

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Purpose:

- ensure the new helper integrates cleanly with `PlmAuditView.vue`
- ensure the post-feedback target narrowing is type-safe

## Full Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Purpose:

- protect existing PLM workbench, audit, approvals, and collaborative state regressions
- confirm the new audit management feedback logic does not disturb other management flows
