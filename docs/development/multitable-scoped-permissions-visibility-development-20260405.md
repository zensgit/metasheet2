# Multitable Scoped Permissions Visibility Development Report

Date: 2026-04-05
Branch: `codex/multitable-scoped-permissions-visibility-20260405`

## Scope

This slice extends scoped multitable permissions from readonly semantics to true field-level hidden semantics driven by field properties.

The goal is to treat `property.hidden === true` and `property.visible === false` as real permission-level hiding without changing the meaning of `view.hiddenFieldIds`, which remains a view configuration concern for user-controlled column hiding.

## Runtime Changes

### Backend permission derivation

Updated `/packages/core-backend/src/routes/univer-meta.ts` so scoped `fieldPermissions.visible` now becomes `false` when either:

- the field is hidden by the current view config through `hiddenFieldIds`
- the field property marks it as hidden through `property.hidden === true` or `property.visible === false`

This preserves the existing readonly behavior and extends it with a separate hidden-permission axis.

### Field property hidden enforcement

Added backend helpers to centralize field mutation and visibility rules:

- property-hidden detection
- mutation guard derivation for select/link/attachment/string fields
- response data filtering by allowed field ids
- summary filtering for attachment and link summary maps

This removed duplicated per-route field-guard code and aligned read/write behavior.

### Read-side filtering

Updated multitable read responses so property-hidden fields no longer leak through runtime payloads:

- `/api/multitable/view`
  - response `fields` excludes property-hidden fields
  - row `data` is filtered to property-visible fields
  - attachment/link summaries are filtered to property-visible fields
  - search/filter/sort field sets only treat property-visible fields as accessible
- `/api/multitable/form-context`
  - response `fields` and record `data` exclude both property-hidden fields and form-hidden `hiddenFieldIds`
- `/api/multitable/records/:recordId`
  - response `fields` and `record.data` exclude property-hidden fields
  - view-hidden fields are still returned here and controlled through `fieldPermissions.visible`, preserving record-drawer semantics

### Write-side enforcement

Updated multitable write routes so property-hidden fields are rejected as forbidden updates:

- `/api/multitable/views/:viewId/submit`
- `/api/multitable/records/:recordId`
- `/api/multitable/patch`

Error semantics added:

- field-level validation message: `Field is hidden`
- route-level error code for hidden-only updates: `FIELD_HIDDEN`

This keeps view-hidden form fields on the existing validation path (`Field is not available in this form`) while making property-hidden fields a true permission rejection.

## Test Updates

Updated:

- `/packages/core-backend/tests/integration/multitable-context.api.test.ts`
- `/packages/core-backend/tests/integration/multitable-record-form.api.test.ts`
- `/apps/web/tests/multitable-grid.spec.ts`

The new and expanded coverage verifies:

- property-hidden fields produce `visible: false` in scoped field permissions
- form context redacts property-hidden fields from `fields` and record `data`
- record context redacts property-hidden fields but preserves view-hidden semantics
- view payloads exclude property-hidden fields from `fields`, rows, and summaries
- form submit rejects property-hidden fields with `FIELD_HIDDEN`
- bulk patch rejects property-hidden fields with `FIELD_HIDDEN`
- frontend grid `visibleFields` respects `fieldPermissions.visible === false`
