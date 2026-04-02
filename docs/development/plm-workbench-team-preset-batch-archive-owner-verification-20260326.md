# PLM Workbench Team Preset Batch Archive Owner Verification

## Focus

Verify that batch archive:

- clears selector-owned drafts when the processed target is archived
- preserves the canonical requested preset owner when only a pending local selector target is archived

## Added Coverage

In `/apps/web/tests/usePlmTeamFilterPresets.spec.ts`:

- explicit archived owner now clears stale `teamPresetOwnerUserId`
- pending local selector batch archive keeps `requestedPresetId = A` while clearing local selector drafts for `B`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `tests/usePlmTeamFilterPresets.spec.ts`: `28` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`: `53` files / `391` tests passed
