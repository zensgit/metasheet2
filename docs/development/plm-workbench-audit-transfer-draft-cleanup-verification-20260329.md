# PLM Workbench Audit Transfer Draft Cleanup Verification

## Verified behavior

- Successful audit team-view transfer now clears completed `name / owner` drafts.
- Passive log-route takeover still preserves ownerless create-mode drafts.
- Transfer no longer leaves stale management drafts attached to the next canonical audit team-view target.

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewOwnership.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
