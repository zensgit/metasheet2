# PLM Workbench Audit Direct Error Contract Verification

Date: 2026-03-29
Commit: pending

## Goal

Verify that PLM workbench audit direct routes now share one consistent `500` contract across:

- backend runtime
- source/dist OpenAPI
- generated SDK path types
- SDK runtime helpers

## Backend Runtime Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-audit-routes.test.ts
```

Validated:

- list route returns `{ success: false, error: 'Failed to load PLM collaborative audit logs' }`
- summary route returns `{ success: false, error: 'Failed to load PLM collaborative audit summary' }`
- csv export route returns `{ success: false, error: 'Failed to export PLM collaborative audit logs' }`

## OpenAPI Build Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts
```

Validated:

- source OpenAPI merges successfully
- generated dist artifacts are refreshed from the updated schema

## SDK Build and Contract Verification

Commands:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm build
pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

Validated:

- generated `paths` now expose `DirectErrorResponse` for the three audit direct routes
- SDK runtime continues to surface direct string errors for list, summary, and csv export helpers

## Web Consumer Smoke

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Validated:

- the web workbench client still passes focused audit client regression coverage after the contract update
