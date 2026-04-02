# PLM Workbench Panel Share Product Context Design

## Problem

`documents` and `approvals` team-view share URLs only serialized panel-local filter and sort state. On a fresh `/plm` open, route hydration would restore `documentTeamView` or `approvalsTeamView`, but `PlmProductView` only loads product-scoped panel data when `autoload=true` and a product identity is present. The result was a partial deep link: the collaborative owner hydrated, but the actual product, document list, and approval list did not cold-load.

## Design

Keep the existing team-view state schema unchanged and transport the current product context at share-link build time instead.

- Extend `buildPlmWorkbenchTeamViewShareUrl(...)` with optional route context:
  - `productId`
  - `itemNumber`
  - `itemType`
- For `documents` and `approvals` share URLs:
  - append the provided product identity fields
  - append `autoload=true` whenever `productId` or `itemNumber` is present
- Leave the existing no-context behavior unchanged so the helper stays backward-compatible for tests and non-product call sites.
- Update `PlmProductView` share call sites for document and approval team views to pass the current product context, omitting default `itemType`.

## Why This Shape

- It fixes cold-open share links without widening the persisted team-view state model.
- It avoids reusing CAD-specific transport rules for panels that do not own their own primary entity id.
- It preserves existing runtime for any caller that intentionally builds a context-free URL.
