# PLM Workbench Panel Scope Roundtrip Verification

## Date
- 2026-03-26

## Verified Behavior
- collaborative snapshot 会保留显式 `panel` scope，同时继续剥离本地 `bomFilterPreset` / `whereUsedFilterPreset` / `approvalComment`
- `panel=approvals,documents` 与 `panel=documents,approvals` 会被视为同一语义，不会触发 false drift
- workbench team view share URL 会带上 canonicalized `panel`
- audit `returnToPlmPath` 会带上 canonicalized `panel`

## Focused Validation
```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

## Full Validation
```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result
- Focused: `1` file / `13` tests passed
- Type-check: passed
- Full suite: `55` files / `411` tests passed
