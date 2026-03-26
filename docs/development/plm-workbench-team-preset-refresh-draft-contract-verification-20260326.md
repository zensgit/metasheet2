# PLM Workbench Team Preset Refresh Draft Contract Verification

## Coverage

Added focused regressions in
`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts`
for:

- clearing stale `name/group/owner` drafts when refresh removes the selected team preset
- preserving create-mode `name/group/owner` drafts when refresh runs without an active selection

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused preset suite passes
- type-check passes
- full PLM frontend suite passes
