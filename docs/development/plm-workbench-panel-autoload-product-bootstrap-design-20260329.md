# PLM Workbench Panel Autoload Product Bootstrap Design

## Problem

`documents` and `approvals` team-view share URLs now transport product identity plus `autoload=true`, but `/plm` cold-open still only bootstrapped product data when the route already had a `productId` and the selected panel explicitly included `product`. That left an item-number-only gap: route hydration restored the collaborative owner, but the page never resolved canonical product context, so the document or approval panel did not actually load.

## Design

Introduce a pure helper, `shouldAutoloadPlmProductContext(...)`, in `plmWorkbenchViewState.ts`.

The helper returns `true` when:

- either `productId` or `itemNumber` exists, and
- the effective panel scope is `all`, `product`, `documents`, or `approvals`

Then update `PlmProductView.applyQueryState()` to:

- call `loadProduct()` whenever that helper says product bootstrap is required
- keep the direct `loadDocuments()` / `loadApprovals()` path only for the non-bootstrap case

## Why This Shape

- It closes the runtime gap for item-number-only share links without widening route schema again.
- It keeps the bootstrap rule unit-testable outside the large `PlmProductView` component.
- It preserves existing non-product panel autoload behavior for `cad`, `where-used`, `compare`, and `substitutes`.
