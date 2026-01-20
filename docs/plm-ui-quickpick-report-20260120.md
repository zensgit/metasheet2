# PLM UI Quick Pick Enhancements (2026-01-20)

## Goal
Reduce manual copy/paste when filling Where-Used, BOM Compare, and Substitutes inputs by reusing already-loaded BOM/search data.

## Scope
- UI: `apps/web/src/views/PlmProductView.vue`
- Add quick-pick dropdowns for:
  - Where-Used child ID
  - BOM Compare left/right IDs
  - Substitutes BOM line ID
  - Substitutes item ID

## Implementation Summary
- Added quick-pick state refs (`whereUsedQuickPick`, `compareLeftQuickPick`, `compareRightQuickPick`, `bomLineQuickPick`, `substituteQuickPick`).
- Built unified option catalogs:
  - `searchResultOptions` from current search results.
  - `bomChildOptions` + `bomLineOptions` from current BOM rows (filtered if a BOM filter is active).
  - `whereUsedQuickOptions` / `substituteQuickOptions` merged and de-duplicated by ID.
  - `compareQuickOptions` from search results.
- Added lightweight apply handlers that fill the corresponding IDs and update deep-link sync where relevant.

## UX Notes
- Quick-pick labels include source tags ("BOM", "BOM 行", "搜索") and item identifiers.
- Selecting a quick-pick option fills the ID immediately and clears the selection for the next use.
- Where-Used / BOM line quick picks clear existing errors and keep the user in control of when to query.

## Verification
- `scripts/verify-plm-ui-full.sh` run on 2026-01-20 (see verification reports in `docs/`).
