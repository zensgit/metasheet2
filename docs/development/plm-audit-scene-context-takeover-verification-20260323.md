# PLM Audit Scene-Context Takeover Verification

## Scope

验证 scene banner 的 route pivots 现在会像 saved-view takeovers 一样接管旧的 collaboration owner，而不是在 canonical `teamViewId` 不变化时留下旧 draft。

## Checks

- collaboration helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
  - `1` 个文件，`41` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` 个文件，`300` 个测试通过

## Verified Outcome

- scene-context route actions now reuse the same takeover cleanup as saved-view takeovers
- draft-owned single-row selection is cleared before scene-context route sync
- scene banner pivots no longer rely on canonical-team-view watcher cleanup to remove stale collaboration ownership
