# PLM Workbench List Metadata SDK Parity Verification

## Scope

Verified that team-view and team-preset list metadata now survives:

1. backend/OpenAPI contract
2. runtime SDK helper
3. web collaborative client normalization

## Focused verification

### SDK

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm build
pnpm exec vitest run tests/client.test.ts
```

Checks:

- `listTeamViews(...)` returns `{ items, metadata }`
- `listTeamFilterPresets(...)` returns `{ items, metadata }`
- existing mutation helpers still pass

### Web client

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Checks:

- `listPlmWorkbenchTeamViews(...)` preserves normalized metadata
- `listPlmTeamFilterPresets(...)` preserves normalized metadata
- save/default/delete behavior remains unchanged

## Safety regression

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected result:

- type-check passes
- PLM frontend regression suite remains green after the envelope change

## Result

This change is verified when both list helpers preserve metadata end-to-end and no PLM frontend regressions appear.
