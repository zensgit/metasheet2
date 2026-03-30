# PLM Deep-Link autoload Panel-Scope Parity — Design

**Date:** 2026-03-30
**Area:** share/deep-link bootstrap · hydration

## Gap

`PlmProductView.vue` → `buildDeepLinkParams(includeAutoload=true)` decides
whether to set `autoload=true` in the return-path URL using an **inline
boolean check** that ignores the active panel scope:

```typescript
const shouldAutoload =
  Boolean(productId.value || productItemNumber.value) ||   // ← panel-unaware
  Boolean(cadFileId.value) ||
  …
```

The canonical utility `shouldAutoloadPlmWorkbenchSnapshot` (used by
`buildPlmWorkbenchTeamViewShareUrl` for share links) delegates product-context
detection to `shouldAutoloadPlmProductContext`, which is **panel-scope-aware**:
product context only triggers autoload when the selected panels include a
product-adjacent panel (`product`, `documents`, `approvals`, `where-used`,
`compare`, or `substitutes`).

### Impact

When the user is viewing a **CAD-only panel** (`panel=cad`) but still carries
product context from a prior navigation, the inline check sets
`autoload=true` in the `returnToPlmPath`.  On return from audit, the autoload
hydration path in `resolvePlmHydratedPanelDataReset` fires with
`autoload=true`, discovers that the CAD panel scope excludes
product-adjacent panels, and sets `clearProduct=true` / `clearBom=true` /
`clearDocuments=true` / `clearApprovals=true` — unnecessarily wiping cached
product data the user might need when switching back to those panels.

### Reproduction

1. Navigate to PLM workbench with `panel=cad&cadFileId=cad-1&productId=prod-100`
2. Open recommended-scene audit (`openWorkbenchSceneAudit`)
3. `buildDeepLinkParams(true)` → sets `autoload=true` (wrong: cad scope
   shouldn't trigger product autoload)
4. Return via `returnToPlmPath`
5. `resolvePlmHydratedPanelDataReset` enters autoload path → clears product data

## Fix

Replace the inline autoload derivation with a call to the canonical
`shouldAutoloadPlmWorkbenchSnapshot`, which is already panel-scope-aware:

```diff
- if (includeAutoload) {
-   const shouldAutoload =
-     Boolean(productId.value || productItemNumber.value) ||
-     Boolean(cadFileId.value) ||
-     Boolean(whereUsedItemId.value) ||
-     Boolean(compareLeftId.value && compareRightId.value) ||
-     Boolean(bomLineId.value) ||
-     Boolean(searchQuery.value)
-   if (shouldAutoload) {
-     params.autoload = true
-   }
- }
+ if (includeAutoload && shouldAutoloadPlmWorkbenchSnapshot(params as Record<string, string>)) {
+   params.autoload = true
+ }
```

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/PlmProductView.vue` | Import `shouldAutoloadPlmWorkbenchSnapshot`; replace inline derivation |
| `apps/web/tests/plmWorkbenchViewState.spec.ts` | +1 test (5 assertions): panel-scope-aware autoload derivation |
