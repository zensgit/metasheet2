# PLM Workbench Audit Saved-View Followup Runtime Verification

## Focused Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSavedViewShareFollowup.spec.ts
```

Expected:

- runtime followups remain unchanged when the referenced saved view still exists
- runtime followups clear to `null` when the referenced saved view has disappeared
- existing explicit feedback expectations remain green

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

- PLM frontend regression suite remains green after the saved-view followup runtime cleanup change
