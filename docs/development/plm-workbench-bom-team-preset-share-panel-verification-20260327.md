# PLM Workbench BOM Team Preset Share Panel Verification

## Scope

Verify BOM team preset share links now emit a valid panel scope.

## Focused Checks

1. Run:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmFilterPresetUtils.spec.ts`

2. Confirm the BOM share-link assertion now expects:

   - `panel=product`
   - `bomTeamPreset=<id>`
   - preserved `bomFilter`
   - preserved non-default `bomFilterField`

3. Re-run frontend type-check:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm --filter @metasheet/web type-check`

4. Re-run frontend PLM suite:

   `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Result

- focused test passes with the normalized `panel=product` contract
- no type regressions
- no PLM frontend regressions
