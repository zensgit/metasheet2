# PLM Workbench Pending Restore Draft Cleanup Verification

## Date
- 2026-03-26

## Verified Behavior
- 当 batch `restore` 命中 pending local selector target 且 canonical owner 仍保留时：
  - `team views` 的 `teamViewName / teamViewOwnerUserId` 会被清空
  - `team presets` 的 `teamPresetName / teamPresetGroup / teamPresetOwnerUserId` 会被清空
- `requestedViewId/requestedPresetId` 仍保持原 canonical owner，不被 restore 的 pending selector 劫持

## Focused Validation
```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
```

## Full Validation
```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result
- Focused: `2` files / `77` tests passed
- Type-check: passed
- Full suite: `55` files / `411` tests passed
