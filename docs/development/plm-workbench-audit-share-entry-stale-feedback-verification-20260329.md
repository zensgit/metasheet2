# PLM Workbench Audit Share-Entry Stale Feedback Verification

Date: 2026-03-29
Commit: pending

## Goal

Verify that audit shared-entry actions now clear stale shared-entry ownership when their canonical team-view target has disappeared, instead of leaving a dead shared-entry banner in place.

## Focused Share-Entry Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts
```

Validated:

- missing shared-entry targets still return the canonical explicit feedback
- stale shared-entry ownership is now recognized as cleanup-worthy when an action feedback target is missing

## Web Type Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Validated:

- the new shared-entry cleanup helper integrates cleanly into `PlmAuditView.vue`

## Frontend Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Validated:

- the full PLM frontend regression suite remains green after the shared-entry stale cleanup change
