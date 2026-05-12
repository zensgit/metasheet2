# K3 WISE Document Template Delivery Verification - 2026-05-11

## Summary

This verification covers the K3 WISE material/BOM template slice:

- Backend template registry.
- K3 WebAPI adapter body projection and preview.
- Pipeline dry-run K3 payload preview.
- Frontend K3 setup page template cards and JSON preview.
- Windows/on-prem package inclusion guard.

Customer live K3 WISE was not exercised in this slice. Live Save-only remains
blocked on customer GATE answers.

## Template Matrix

| Template | Target object | K3 endpoint | Body key | Required K3 fields |
|---|---|---|---|---|
| `k3wise.material.v1` | `material` | `/K3API/Material/Save` | `Data` | `FNumber`, `FName` |
| `k3wise.bom.v1` | `bom` | `/K3API/BOM/Save` | `Data` | `FParentItemNumber`, `FChildItemNumber`, `FQty` |

Material preview payload:

```json
{
  "Data": {
    "FNumber": "MAT-001",
    "FName": "Bolt",
    "FModel": "M6 x 20",
    "FBaseUnitID": "Pcs"
  }
}
```

BOM preview payload:

```json
{
  "Data": {
    "FParentItemNumber": "FG-001",
    "FChildItemNumber": "MAT-001",
    "FQty": 2,
    "FUnitID": "PCS",
    "FEntryID": 1
  }
}
```

## Backend Assertions

`plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs` verifies:

- `material` schema exposes `k3wise.material.v1` metadata.
- `previewUpsert()` builds `{ Data: { FNumber, FName } }`.
- Preview request query redacts the K3 token placeholder.
- `autoSubmit` / `autoAudit` default to false unless explicitly configured.
- Absolute K3 object endpoints are rejected.

`plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs`
verifies:

- K3 Save receives only K3 `Data` fields, not internal integration fields.
- Dry-run attaches `preview.records[].targetPayload.Data`.
- Dry-run target request redacts `Token`.
- Writeback still records ERP feedback after a successful Save.
- Validation failures still enter the dead-letter path without stopping the
  whole batch.

## Frontend Assertions

`apps/web/tests/k3WiseSetup.spec.ts` verifies:

- Pipeline payloads include `options.k3Template` for material and BOM.
- Template field mappings drive the payloads instead of local hardcoded arrays.
- Preview JSON contains K3 fields but no `authorityCode`, `Token`, password,
  `sourceId`, `revision`, or `_integration_*` fields.
- Save-only remains the default pipeline lifecycle.

`apps/web/tests/IntegrationK3WiseSetupView.spec.ts` verifies:

- The K3 setup page renders the `K3 单据模板` section.
- The material/BOM template cards render mapping fields such as `FNumber`.
- The JSON preview renders a `Data` envelope.
- The preview does not expose credential labels such as `authorityCode`.

## On-Prem Package Assertions

`scripts/ops/multitable-onprem-package-verify.sh` now treats the K3 document
template registry and K3 operator runbooks as required package content:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
- `docs/operations/k3-poc-onprem-preflight-runbook.md`
- `docs/operations/integration-k3wise-live-gate-execution-package.md`

This ensures the Windows/on-prem ZIP fails verification if the template runtime
or operator docs are accidentally omitted.

## Commands Run

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

Result: PASS.

```bash
node plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs
```

Result: PASS.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/k3WiseSetup.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  --watch=false
```

Result: PASS, 2 files / 28 tests.

| Command | Result |
|---|---|
| `node --check plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs` | PASS |
| `node --check plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` | PASS |
| `node --check plugins/plugin-integration-core/lib/pipeline-runner.cjs` | PASS |
| `pnpm -F plugin-integration-core test` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `pnpm verify:integration-k3wise:poc` | PASS |
| `PACKAGE_TAG=k3wise-template-local INSTALL_DEPS=0 BUILD_WEB=0 BUILD_BACKEND=0 scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3wise-template-local.zip` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3wise-template-local.tgz` | PASS |
| `git diff --check` | PASS |

The first `pnpm verify:integration-k3wise:poc` run exposed a stale mock-chain
assertion that still required the older `FChildItems[]` BOM shape. The mock
fixture was updated to assert the v1 template contract
(`FParentItemNumber`, `FChildItemNumber`, `FQty`, `FUnitID`, `FEntryID`) and
the command then passed.

## Remaining Risk

- Live K3 WISE Save-only is not validated until customer GATE answers are
  available.
- Unit code dictionary values (`PCS`, `EA`, `KG`) are seed defaults. Customer
  unit codes must be reconciled during the live PoC.
- Only material and BOM are in scope. Other K3 documents remain v2 template
  candidates after the first customer PoC passes.
