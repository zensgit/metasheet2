# PLM Workbench Team Preset Default Signal Runtime Verification

## Focused verification

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Checks:

- `listPlmTeamFilterPresets(...)` keeps `items[0].lastDefaultSetAt`
- `setPlmTeamFilterPresetDefault(...)` keeps `lastDefaultSetAt` on the returned preset
- existing clear/delete behavior stays unchanged

## Safety regression

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Checks:

- no regression in PLM web client mapping
- full PLM frontend suite remains green after the signal parity fix
