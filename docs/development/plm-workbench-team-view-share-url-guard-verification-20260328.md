# PLM Workbench Team View Share URL Guard Verification

## Scope

Verify that `team view` share stops before clipboard copy when the generated deep link is empty.

## Focused Regression

- Added a `usePlmTeamViews` regression that:
  - loads a shareable workbench team view
  - makes `buildShareUrl(...)` return an empty string
  - verifies `copyShareUrl(...)` is never called
  - verifies the handler reports `生成工作台团队视角分享链接失败。`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run apps/web/tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- Focused `usePlmTeamViews.spec.ts`: pass
- Frontend type-check: pass
- Full PLM frontend suite: pass
