# PLM Audit Scene Context Canonical Team View Verification

## Verified Behavior

- `clear / owner / scene` 这组三个 scene-context route action 不再把未 `Apply` 的 Team views 下拉写回 canonical route。
- `Save scene view` 和 `Save scene to team/default` 不再把 selector drift 带进 scene save snapshot。
- source=`scene-context` 的本地 saved-view followup 会保留当前筛选草稿，但 `teamViewId` 回退到 canonical route owner。

## Focused Validation

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSceneContext.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Actual result:

- `type-check` passed
- focused Vitest run passed with `3` files and `17` tests

## Full Regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Actual result:

- full PLM frontend regression passed
- `45` files and `276` tests passed
