# K3 WISE Staging Field Detail Contract Design - 2026-04-29

## Context

PR `#1252` made the K3 WISE postdeploy smoke verify that the five integration
staging descriptors expose all required field IDs. That closed the largest
false-positive gap: a deployment could no longer pass while omitting
`standard_materials.erpSyncStatus` or `integration_exceptions.errorMessage`.

One residual risk remained. A field ID could exist with the wrong multitable
type or an incomplete `select` option set. That would still break the operator
workflow because status fields such as material lifecycle, ERP sync state,
exception queue state, and run mode rely on exact select choices.

## Design

The integration plugin keeps the existing descriptor response contract:

```json
{
  "id": "standard_materials",
  "name": "Standard Materials",
  "fields": ["code", "name", "status"]
}
```

It now adds an additive `fieldDetails` array:

```json
{
  "fieldDetails": [
    { "id": "code", "name": "Material Code", "type": "string" },
    {
      "id": "status",
      "name": "Status",
      "type": "select",
      "options": ["draft", "active", "obsolete"]
    }
  ]
}
```

This avoids breaking existing consumers that expect `fields: string[]` while
giving postdeploy smoke enough detail to validate the real staging contract.

The exposed detail intentionally includes only:

- `id`
- `name`
- `type`
- `options` for select fields

It does not expose `property.validation` yet. Required-field validation remains
an internal provisioning concern until a user-facing contract needs it.

## Postdeploy Guard

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` now validates:

- all required descriptor IDs.
- all required field IDs.
- each required field type.
- required select options for status/mode fields.

The validator remains tolerant of future rich `fields` responses. It can read
field details from either:

- `fieldDetails: [{ id, type, options }]`
- `fields: [{ id, type, options }]`

The plugin currently uses the safer additive `fieldDetails` shape.

## Failure Evidence

Descriptor failures now include two detail groups:

```json
{
  "missingFields": {
    "standard_materials": ["erpSyncStatus"]
  },
  "invalidFields": {
    "standard_materials": {
      "status": [
        "expected type select but got string",
        "missing options: active, obsolete"
      ]
    }
  }
}
```

The GitHub summary renderer prints `invalidFields` alongside existing
`missingAdapters`, `missingRoutes`, and `missingFields` details.

## Files

- `plugins/plugin-integration-core/lib/staging-installer.cjs`
- `plugins/plugin-integration-core/__tests__/staging-installer.test.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`

## Compatibility

This is an additive API change. Existing callers that render or compare
`descriptor.fields` continue to receive the same string array. New callers can
use `descriptor.fieldDetails` when they need field type or option metadata.
