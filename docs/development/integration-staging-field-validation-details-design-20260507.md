# Integration Staging Field Validation Details Design

Date: 2026-05-07

## Context

`plugin-integration-core` provisions the user-visible multitable staging sheets
used by the PLM -> ERP cleaning flow:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

The raw descriptor authoring format supports `required: true`, then
`materializeField()` converts that into the real multitable contract:
`property.validation: [{ type: 'required' }]`.

## Problem

`listStagingDescriptors()` is the lightweight descriptor surface consumed by
postdeploy smoke checks and by future frontend setup/readiness pages. It
returned each field detail as only:

- `id`
- `name`
- `type`
- `options`

That meant callers could see field names and select options, but could not see
the validation metadata that marks required staging fields. The actual staging
fields were still provisioned correctly, but the descriptor API lost the
required-field signal.

## Change

`summarizeField()` now includes a defensive copy of `field.property` when it is
present, including `property.validation`.

The top-level authoring-only `required` flag remains stripped. Consumers should
read required-ness through the same contract the multitable runtime uses:

```json
{
  "property": {
    "validation": [{ "type": "required" }]
  }
}
```

## Non-Goals

- This does not change the sheet provisioning payload.
- This does not introduce a new top-level `required` field.
- This does not change K3 adapter behavior or live customer write behavior.
