# PLM Audit Team View Metadata Route Preservation Verification

## Verified Behavior

- `rename / transfer owner` 不再把当前页面本地切回 team-view snapshot。
- default/log/followup route 在 metadata-only action 之后继续保持原有上下文。
- team-view selector 和 management focus 仍然会锁回被修改的目标 view。

## Focused Validation

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewRouteState.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Actual result:

- `type-check` passed
- focused Vitest run passed with `3` files and `46` tests

## Full Regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Actual result:

- full PLM frontend regression passed
- `45` files and `276` tests passed
