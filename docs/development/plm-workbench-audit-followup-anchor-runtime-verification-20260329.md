# PLM Workbench Audit Followup Anchor Runtime Verification

## Focused Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- `resolvePlmAuditTeamViewCollaborationRuntimeFollowup(...)` reports `changed: true` when a stale scene-context anchor must be moved to team-view controls
- it reports `changed: false` once the followup is already normalized
- existing collaboration/followup tests remain green

## Safety Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView` compiles with the runtime followup normalizer and watcher

## Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- PLM frontend regression suite remains green after the persisted followup-anchor normalization change
