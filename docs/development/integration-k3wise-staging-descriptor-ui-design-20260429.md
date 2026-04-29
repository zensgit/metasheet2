# K3 WISE Staging Descriptor UI Guardrail Design - 2026-04-29

## Context

PR `#1254` exposed staging descriptor `fieldDetails` from the integration
plugin and made postdeploy smoke validate field types and select options.
That made the backend contract observable, but the K3 WISE setup page still
treated pipeline feedback staging objects as free-text fields.

An operator could therefore typo `standard_materials` or `bom_cleanse` and
create draft pipelines pointing at a non-existent or stale feedback surface.
The backend would only fail later when the pipeline attempted to write ERP
feedback.

## Design

The setup page now consumes the existing read-only endpoint:

`GET /api/integration/staging/descriptors`

The page loads descriptors:

- silently on mount, so the page can render with or without auth/route support.
- after successful staging installation, so the preview reflects the latest
  provisioned contract.
- manually through `刷新 Staging 契约`.

When descriptors are available:

- the sidebar shows each descriptor name, logical id, field count, field type
  breakdown, and select-option counts.
- the material and BOM staging object fields become descriptor-backed selects.
- pipeline-template validation rejects selected object IDs that do not match
  the loaded descriptor set.

When descriptors are unavailable:

- the form keeps the previous free-text inputs.
- validation remains permissive for custom or legacy staging object IDs.

This keeps old deployments usable while turning the richer descriptor contract
into direct setup-page guardrails when the endpoint is present.

## Files

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Operator Effect

The K3 WISE page now answers two practical setup questions without asking the
operator to inspect JSON:

- which staging multitable objects are available.
- which object ID will be used by material and BOM ERP feedback.

The change is read-only until the operator clicks the existing install or
pipeline creation buttons.
