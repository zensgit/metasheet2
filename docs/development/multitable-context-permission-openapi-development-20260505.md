# Multitable Context Permission OpenAPI Development - 2026-05-05

## Scope

This slice aligns the remaining multitable context OpenAPI schemas with the
permission-aware runtime responses now returned by the backend.

It follows the same cleanup direction as the record drawer contract update:
document the fields the routes actually emit, and stop advertising older
`fieldCapabilities` / `dependencyGraph` fields where those routes no longer
return them.

## Runtime Surfaces Checked

- `GET /api/multitable/context`
- `GET /api/multitable/view`
- `GET /api/multitable/form-context`

## Changes

- Added `MultitableScopedPermissions` for the shared permission payload used in
  `MultitableViewMeta.permissions`.
- Added `member-group` to `MultitableSheetPermissionSubjectType`, matching the
  runtime/frontend sheet-permission subject contract.
- Extended `MultitableViewMeta` with:
  - `capabilityOrigin`
  - `permissions`
- Extended `MultitableContext` with:
  - `capabilityOrigin`
  - `fieldPermissions`
  - `viewPermissions`
- Extended `MultitableFormContext` with:
  - `capabilityOrigin`
  - `fieldPermissions`
  - `viewPermissions`
  - `rowActions`
- Removed stale `fieldCapabilities` / `dependencyGraph` properties from:
  - `MultitableViewData`
  - `MultitableFormContext`
- Removed stale `fieldCapabilities` from `MultitableContext`.
- Regenerated `packages/openapi/dist/*`.
- Added parity assertions in `scripts/ops/multitable-openapi-parity.test.mjs`.

## Why This Is OpenAPI-only

The backend and frontend types were already permission-aware:

- the context route returns `capabilityOrigin`, `fieldPermissions`, and
  `viewPermissions`;
- the view route nests permission information under `data.meta`;
- the form-context route returns field permissions and conditionally returns
  capability origin, view permissions, and row actions;
- `apps/web/src/multitable/types.ts` already models these fields.

The stale part was the published OpenAPI contract and its generated dist files.

## Compatibility Notes

- `MultitableFormContext.capabilityOrigin` is optional because public form access
  intentionally omits host-user capability origin.
- `MultitableFormContext.rowActions` is optional because create-form context does
  not include an existing record.
- `MultitableViewMeta` remains optional on `MultitableViewData`, matching the
  existing schema shape, but now describes the permission fields present when
  meta is emitted.
