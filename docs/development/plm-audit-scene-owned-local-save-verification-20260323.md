# PLM Audit Scene-Owned Local Save Verification

Date: 2026-03-23

## Scope

Verify that scene-owned local save now:

- only assigns `scene-context` provenance when scene owner/query context is actually active
- clears stale management/source attention before installing the new local-save followup
- stores canonical scene snapshots when users invoke `Save scene view`

## Type Safety

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Focused Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditSceneContext.spec.ts
```

Result:

- `3` files passed
- `25` tests passed

Covered assertions:

- source-aware local-save attention clears stale management focus before installing a new local followup
- generic local-save followup ownership only falls back to `scene-context` when scene context is still active
- scene saved views normalize drifted routes back to canonical owner/query scene state

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `263` tests passed
