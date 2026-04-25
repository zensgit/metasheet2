# Integration PLM K3 WISE MVP Runbook Verification - 2026-04-24

## Scope

Verify the M2-T06 runbook:

- exists at the planned path.
- documents K3 WISE, not K3 Cloud.
- includes the customer GATE checklist.
- includes WebAPI/K3API, SQL Server channel, staging feedback, deployment,
  operation, troubleshooting, and rollback guidance.
- remains consistent with implemented adapter kinds and tests.

## Commands Run

```bash
test -f packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
rg -n "plm:yuantus-wrapper|erp:k3-wise-webapi|erp:k3-wise-sqlserver|autoSubmit|autoAudit|SQLSERVER_EXECUTOR_MISSING|PLM_CLIENT_MISSING" packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
rg -n "pnpm -F plugin-integration-core test|node --import tsx scripts/validate-plugin-manifests.ts|git diff --check" packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
rg -n "data.adapters|config.defaultProductId|filters.productId" packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
! rg -n "pipeline.options.source.productId|status.adapters" packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Expected Results

- runbook file exists.
- adapter kinds match runtime:
  - `plm:yuantus-wrapper`
  - `erp:k3-wise-webapi`
  - `erp:k3-wise-sqlserver`
  - `http`
- runbook states that Submit/Audit are disabled by default.
- runbook states that SQL Server channel does not accept raw SQL and does not
  write K3 core business tables by default.
- runbook includes mock and customer-test-account acceptance steps.
- runbook documents the actual status response path as `data.adapters`.
- runbook does not claim the runner passes `pipeline.options.source.productId`;
  BOM product selection is documented through PLM external-system
  `config.defaultProductId` or direct adapter `filters.productId`.
- plugin tests and manifest validation stay green.

## Results

- Runbook exists at `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`.
- Cross-check grep confirms the runbook references:
  - `plm:yuantus-wrapper`
  - `erp:k3-wise-webapi`
  - `erp:k3-wise-sqlserver`
  - `autoSubmit`
  - `autoAudit`
  - `PLM_CLIENT_MISSING`
  - `SQLSERVER_EXECUTOR_MISSING`
  - K3 WISE vs K3 Cloud/星空 distinction
  - credential/key custody
  - `GET /api/integration/runs`
  - `options.erpFeedback.enabled`
  - `data.adapters`
  - `config.defaultProductId`
  - `filters.productId`
  - K3 core table read/write restrictions
- `pnpm -F plugin-integration-core test` passes.
- `node --import tsx scripts/validate-plugin-manifests.ts` passes: 13/13
  valid, 0 errors. Existing warnings are unrelated plugin metadata/wildcard
  warnings outside this slice.
- `git diff --check` passes.

## Not Covered

This verification is documentation-level. It does not prove:

- live customer PLM connectivity.
- live K3 WISE WebAPI connectivity.
- live SQL Server connectivity.
- customer-specific field mappings.
- frontend operator workflow.

Those require customer GATE answers and a controlled test-account execution.
