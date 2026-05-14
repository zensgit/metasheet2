# Integration Staging Open Multitable Verification - 2026-05-14

## Summary

Verified the new staging open-link contract at backend unit level and the K3 WISE setup page at frontend component level.

## Commands

| Command | Result |
| --- | --- |
| `node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs` | PASS - staging installer assertions updated to cover 5 sheets, 5 default views, open links, idempotency, partial failure, and legacy no-`ensureView` fallback. |
| `pnpm -F plugin-integration-core test` | PASS - full plugin integration-core test script, including staging installer and existing PLM -> K3 WISE mock chain. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS - 1 file / 3 tests. |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS - 2 files / 34 tests. |
| `pnpm --filter @metasheet/web build` | PASS - `vue-tsc -b` and Vite production build completed. Existing Vite chunk-size warning remains non-blocking. |
| `git diff --check` | PASS - no whitespace errors or conflict markers. |

## Backend Assertions

The staging installer test now proves:

- `ensureObject()` is still called once per staging descriptor.
- `ensureView()` is called once per successfully provisioned sheet.
- Each descriptor returns:
  - `sheetIds[id]`
  - `viewIds[id]`
  - `openLinks[id]`
  - one `targets[]` entry
- Re-running install returns the same sheet ids, view ids, and open links.
- If one descriptor fails, the other sheets and views still install.
- If the plugin host lacks `ensureView`, sheets still install and a warning is returned instead of failing the whole operation.
- Route parts are URI-encoded.

Example asserted link:

```text
/multitable/sheet_standard_materials/view_standard_materials?baseId=base_default
```

## Frontend Assertions

The K3 WISE setup view test now proves:

- The page can install staging tables after `Project ID` is entered.
- The request body includes the entered `projectId`.
- The page renders business-facing open targets after install:
  - `物料清洗`
  - `BOM 清洗`
- The primary card copy does not expose raw `sheetId / viewId` pairs.
- The "打开多维表" links target the generated multitable URLs.

## UX Check

Expected operator flow after this change:

1. Open K3 WISE preset page.
2. Enter `Project ID` and optional `Base ID`.
3. Click `安装 Staging 多维表`.
4. Click `打开多维表` on `物料清洗` or `BOM 清洗`.
5. Clean rows in multitable.
6. Return to the setup page for dry-run and Save-only push.

## Deployment Impact

No migration is required. The change uses the existing multitable provisioning API and existing `/multitable/:sheetId/:viewId` route.

If a deployment has already installed staging sheets, rerunning the installer is expected and idempotent; it will ensure the missing default views and produce open links.
