# PLM Workbench Team-Scope List SDK Parity Verification

Date: 2026-03-29
Commit: pending

## Goal

Verify that the handwritten PLM workbench SDK now matches the real team-scope list contract:

- `kind` may be omitted
- request URLs omit `?kind=...` when no filter is requested
- list metadata may legitimately return `kind: 'all'`

## SDK Build Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm build
```

Validated:

- `client.js` and `client.d.ts` regenerate successfully from the widened SDK source

## SDK Focused Tests

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm exec vitest run tests/client.test.ts
```

Validated:

- `listTeamViews()` succeeds with no `kind` argument
- `listTeamFilterPresets()` succeeds with no `kind` argument
- the generated request URLs do not append `?kind=...`
- `metadata.kind = 'all'` is preserved for both list helpers

## Web Type Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Validated:

- widening SDK list metadata and optional parameters does not break web consumers

## Frontend Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Validated:

- PLM frontend regression suite stays green after the SDK contract widening
