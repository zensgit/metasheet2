# Generic Integration Workbench Docs Closeout Development - 2026-05-13

## Scope

This slice closes the M9 documentation and delivery TODOs for the generic integration workbench plan:

- Update the Windows on-prem runbook.
- Update the K3 WISE runbook.
- Update package verification/delivery scripts for newly required K3 operator docs and smoke scripts.
- Run the K3 offline PoC gate.

## Changes

### Windows on-prem runbook

Updated `docs/deployment/multitable-windows-onprem-easy-start-20260319.md` with:

- `/integrations/workbench` route.
- `/integrations/k3-wise` quick-start route.
- K3 quick-start operator steps.
- Tenant/workspace guidance.
- Base URL vs `/K3API/...` endpoint-path guidance.
- SQL advanced-channel guardrails.
- K3 postdeploy smoke commands.
- Included K3 operator runbook list.

### K3 WISE internal-trial runbook

Updated `docs/operations/integration-k3wise-internal-trial-runbook.md` with an operator UI flow covering:

- K3 preset vs generic workbench responsibilities.
- Blank tenant fallback to `default`.
- Optional workspace context.
- Base URL endpoint path split.
- SQL allowlist and middle-table boundary.
- Secret-free Material/BOM preview behavior.

### Delivery checklist

Updated `docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md` to include the K3 operator runbooks and field-team notes for K3 routes, Base URL, and SQL guardrails.

### Package verification and delivery scripts

Updated:

- `scripts/ops/multitable-onprem-package-verify.sh`
- `scripts/ops/multitable-onprem-delivery-bundle.mjs`

The package verifier now requires:

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`

The delivery bundle now copies the three K3 operator runbooks into the customer-facing docs bundle.

## Non-Goals

- No runtime backend route changes.
- No frontend UI changes.
- No live K3 customer environment call.
