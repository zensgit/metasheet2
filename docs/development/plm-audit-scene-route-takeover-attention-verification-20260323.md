# PLM Audit Scene Route Takeover Attention Verification

## Scope

验证 scene banner / scene token route pivots 现在会像其他 route takeovers 一样，统一清掉 stale saved-view attention 和 collaboration owner。

## Checks

- scene route takeover focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - `3` 个文件，`59` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `47` 个文件，`304` 个测试通过

## Verified Outcome

- scene route takeovers now clear saved-view followup / focus together with collaboration owner
- route pivots no longer rely on watcher side effects to clear stale scene-owned transient UI
- draft-owned single selection is still trimmed conservatively, while user multi-select remains intact
