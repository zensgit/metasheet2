# PLM Panel-Scope Contract Unification — Design

**Date:** 2026-03-30
**Area:** runtime route contract · hydration

## Gap

`plmRouteHydrationContracts.ts` declares `PLM_PANEL_KEYS` as the
**authoritative single-source-of-truth** for valid panel identifiers.
All other modules are expected to consume it instead of duplicating the
panel list.

`plmWorkbenchViewState.ts` still maintained a **private duplicate**:

```typescript
const PLM_WORKBENCH_PANEL_SCOPE_KEYS = [
  'search', 'product', 'documents', 'approvals',
  'cad', 'where-used', 'compare', 'substitutes',
] as const
const PLM_WORKBENCH_PANEL_SCOPE_KEY_SET = new Set<string>(PLM_WORKBENCH_PANEL_SCOPE_KEYS)
```

`normalizePlmWorkbenchPanelScope` validated incoming `panel` query values
against this duplicate set and emitted canonical ordering from the duplicate
array.  If the two lists ever diverged — e.g. a new panel added to the
contract but missed in the local copy — `normalizePlmWorkbenchPanelScope`
would silently strip the new panel from share URLs, return paths, and the
autoload hydration pipeline.

### Impact path

1. Share URL built with `panel=<new-key>` passes through `normalizePlmWorkbenchCollaborativeQuerySnapshot`
2. Which calls `normalizePlmWorkbenchPanelScope`
3. Which uses the local set → rejects the new key → silently drops the panel
4. Recipient opens the link without the panel scope → all-panels autoload → incorrect hydration

## Fix

Delete the private duplicate.  Import `PLM_PANEL_KEYS` from the contracts
module and derive the validation set from it.

```diff
-import { hasProductAdjacentPanelSelected } from './plmRouteHydrationContracts'
+import { hasProductAdjacentPanelSelected, PLM_PANEL_KEYS } from './plmRouteHydrationContracts'
 …
-const PLM_WORKBENCH_PANEL_SCOPE_KEYS = [ … ] as const
-const PLM_WORKBENCH_PANEL_SCOPE_KEY_SET = new Set<string>(PLM_WORKBENCH_PANEL_SCOPE_KEYS)
+const PLM_WORKBENCH_PANEL_SCOPE_KEY_SET = new Set<string>(PLM_PANEL_KEYS)
```

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/plm/plmWorkbenchViewState.ts` | Import `PLM_PANEL_KEYS`; delete 9-line local duplicate; derive set and ordering from contract |
| `apps/web/tests/plmWorkbenchViewState.spec.ts` | +1 test: every `PLM_PANEL_KEYS` entry survives panel-scope normalisation; canonical order preserved |
