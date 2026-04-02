# PLM Workbench Audit CSV SDK Parity Verification

Date: 2026-03-28

## What Changed

The collaborative audit CSV export route is now exposed and consumed through the same OpenAPI/SDK path as the JSON audit APIs:

- source OpenAPI exposes `/api/plm-workbench/audit-logs/export.csv`
- `dist-sdk` exposes `exportCollaborativeAuditLogsCsv(...)`
- `apps/web` delegates CSV export to the SDK helper instead of hand-writing a second fetch contract

## Verification

### OpenAPI build

Command:

```bash
pnpm exec tsx packages/openapi/tools/build.ts
```

Result: passed

### SDK build

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm build
```

Result: passed

### SDK focused tests

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

Result:

- `2` files passed
- `14` tests passed

### Web focused tests

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Result:

- `1` file passed
- `23` tests passed

### Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result: passed

### PLM frontend regression suite

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `62` files passed
- `491` tests passed

## Regression Covered

- SDK path types now fail if `/api/plm-workbench/audit-logs/export.csv` disappears from generated OpenAPI
- SDK runtime now verifies auth + `Accept: text/csv` + filename extraction
- Web client still verifies normalized export query generation and returned `{ filename, csvText }`
