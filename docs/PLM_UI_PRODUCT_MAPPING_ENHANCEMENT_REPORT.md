# PLM UI Product Mapping Enhancement Report

## Goal
Harden the PLM UI product detail and search flows against Yuantus item payload variations (item_number, item_type_id, created_on/modified_on, etc.).

## Changes
- `apps/web/src/views/PlmProductView.vue`
  - Product detail mapping now recognizes `item_name`, `title`, `item_number`, `version_label`, `state/current_state`, `item_type_id/item_type`, and `created_on/modified_on`.
  - Search table and actions now use `item_number`/`itemNumber` when present.
  - Field mapping catalog updated to reflect the expanded fallback keys.

## Behavior
- Loading a product now prefers richer Yuantus fields when available and falls back safely when not.
- Searching by item number surfaces the same identifier in the table and copy actions.

## Verification
- UI regression run: `docs/verification-plm-ui-regression-20260115_231459.md`
- Screenshot: `artifacts/plm-ui-regression-20260115_231459.png`
- Item-number artifact: `artifacts/plm-ui-regression-item-number-20260115_231459.json`
