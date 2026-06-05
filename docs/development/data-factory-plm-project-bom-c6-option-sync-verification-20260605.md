# DF PLM Stock Preparation C6 Option Sync Verification

Date: 2026-06-05

## Scope

C6 adds admin-controlled stock-preparation option synchronization:

- `config_info` option sets can update select/dropdown field metadata for
  `materialType`, `blankType`, and `stockPreparationStatus`.
- The built-in contract option set updates `lastPlmRefreshDecision`.
- Admins may bind an option to a backend predefined action id. This stores
  metadata only; it does not execute an action directly.
- The workbench exposes an admin-only sync panel that posts option config to the
  new backend route.

## Boundaries

- No PLM write.
- No K3 write.
- No MetaSheet business-row write.
- No raw SQL, JavaScript, URL, handler/function body, or arbitrary payload input.
- No client-supplied sheet/source/target/plan/payload scope.
- C5 apply still does not auto-create unknown options.
- Option sync evidence is values-free: field/source keys and counts only, no
  option values or labels.

## Implementation

- `packages/core-backend/src/multitable/provisioning.ts`
  - Adds a narrow `patchObjectFieldProperty` helper.
- `packages/core-backend/src/types/plugin.ts`
  - Adds the provisioning API type for the narrow field-property patch.
- `packages/core-backend/src/multitable/plugin-scope.ts`
  - Applies project namespace and object-scope checks before the patch.
- `packages/core-backend/src/index.ts`
  - Wires the core provisioning implementation.
- `plugins/plugin-integration-core/lib/stock-preparation-option-sync.cjs`
  - Normalizes option sets, rejects redacted/secret-shaped values, rejects
    executable keys, enforces predefined action allowlist, and writes values to
    field metadata through the scoped provisioning API.
- `plugins/plugin-integration-core/lib/http-routes.cjs`
  - Adds admin-only
    `POST /api/integration/stock-preparation/options/sync`.
- `apps/web/src/views/IntegrationWorkbenchView.vue`
  - Adds an admin-only metadata sync panel.

## Tests

Commands run:

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-option-sync.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Results:

- Plugin option-sync helper: pass.
- HTTP routes: pass.
- Workbench view targeted spec: 24/24 pass.

Note: an earlier incorrect command ran the whole frontend suite; the target
`IntegrationWorkbenchView.spec.ts` passed, while unrelated existing attendance /
multitable / feature-flag tests failed. The targeted command above is the
relevant C6 frontend verification.

## Negative Controls

Covered by tests:

- Non-admin cannot call option sync.
- Target not ready fails closed and does not patch fields.
- Duplicate option values fail closed.
- Unknown option source keys fail closed.
- Field metadata patch failures map to values-free 422 errors.
- Prototype-pollution field property patch keys fail closed.
- Redacted/secret-shaped option values fail closed.
- Option `order` must be a numeric non-negative integer; numeric strings fail
  closed.
- Unknown predefined action ids fail closed.
- Executable keys such as `sql`/`handler` fail closed.
- Route evidence omits option values, labels, and sheet ids.
- Frontend request omits `sheetId`, `source`, `target`, `plan`, and `payload`.
