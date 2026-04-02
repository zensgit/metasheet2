# PLM Workbench Audit Transfer Selection Trim Verification

## Verified behavior

- Successful audit team-view transfer now immediately removes readonly transferred targets from batch selection.
- The current selector still stays on the transferred team view, so the page keeps the canonical focus target.
- The trimming behavior is covered through the existing audit ownership helper contract.

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewOwnership.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
