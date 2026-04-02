# PLM Workbench Local Preset Catalog Draft Cleanup Verification

## Scope

验证本地 preset catalog 在 import / clear 后的 selector、route owner、draft cleanup 合同。

## Focused Checks

1. Run:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmFilterPresetUtils.spec.ts`

2. Confirm focused cases cover:

   - stale selected preset disappears -> clear selected key, route owner, name draft, group draft
   - selected preset survives but route owner disappears -> keep selected key and drafts, clear route owner only
   - BOM team preset share URL with legacy `panel=bom` input -> normalize to `panel=product`

3. Re-run frontend type-check:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm --filter @metasheet/web type-check`

4. Re-run frontend PLM suite:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Result

- focused preset util tests pass
- no type regressions
- no PLM frontend regressions
