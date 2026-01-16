# PLM UI BOM Child Actions Report

## Goal
Expose quick actions on BOM rows to jump to child products or copy child identifiers.

## Changes
- `apps/web/src/views/PlmProductView.vue`
  - Added BOM row actions: switch product to child and copy child identifier.
  - Added child number resolution to support `component_code`/`item_number` fallbacks.
  - Relaxed BOM row action guards to use normalized child/line ids.
- `scripts/verify-plm-ui-regression.sh`
  - Added BOM child action assertions (copy child + switch product and restore).

## Behavior
- "切换产品" loads the child component as the active product (prefers ID, falls back to item number).
- "复制子件" copies the child ID if available, otherwise copies the child item number.

## Verification
- UI regression: `docs/verification-plm-ui-regression-20260116_132934.md`
- Screenshot: `artifacts/plm-ui-regression-20260116_132934.png`
