# PLM UI BOM Tools Enhancement Report (2026-01-15)

## Scope
Enhance the PLM UI panels for Where-Used / BOM Compare / Substitutes so they are more resilient to payload shape differences, more searchable when compare payloads omit child fields, and easier to navigate in tree view.

## Changes
- `apps/web/src/views/PlmProductView.vue`
  - Added `resolveCompareLineProps()` helper to normalize compare line properties from `line`, `properties`, `relationship.properties`, or `relationship`.
  - `getCompareProp()` now supports snake→camel key fallback.
  - `formatEffectivity()` and `formatSubstituteCount()` now:
    - use normalized line props;
    - fall back to `before_line` / `after_line` when present;
    - emit `before → after` when values differ.
  - Compare filter now includes:
    - path nodes (`path[].id/item_number/name/...`)
    - line props (`find_num`, `refdes`, `quantity`, `uom`)
    - this keeps filtering effective even when `include_child_fields=false`.
  - Where-Used tree view supports expand/collapse per node and expand/collapse all controls.
  - BOM Compare changed rows now get severity-tinted row backgrounds for faster scanning.

## Why
- Yuantus BOM compare payloads can return data in `line`, `properties`, or `relationship.properties`; UI should not lose fields depending on mode.
- Changed entries carry `before_line`/`after_line`, which we now surface in effectivity/substitute fields for quick inspection.
- When child fields are excluded, only `path` remains; filtering by path keeps search usable.
- Tree view expands rapidly on deep BOMs; collapse controls make navigation manageable.
- Severity shading reduces time spent scanning changed rows.

## Verification
- BOM tools seed (Yuantus @ 7911): `artifacts/plm-bom-tools-20260115_2229.md`
- UI regression (tree/compare UI): `docs/verification-plm-ui-regression-20260115_222941.md`
