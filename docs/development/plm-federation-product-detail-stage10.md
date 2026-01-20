# PLM Federation Product Detail Stage 10

## Goal

Harden Yuantus product detail mapping so AML get responses and search hits map consistently to UI-friendly fields.

## Changes

- Extend Yuantus item field mapping to accept `item_type_id` and top-level `item_number` when present.
- Merge search hit item type from `properties.item_type_id` when available.
- Defensive unwrap for AML get responses that return an envelope with `items`.

## Files Touched

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`

## Behavior Notes

- Product detail mapping now prefers `item.type`, then `item.item_type_id`, then `properties.item_type_id`.
- Part number mapping accepts a top-level `item_number` (if returned by upstream).
- `getProductById` tolerates AML responses that wrap results in `{ items: [...] }`.

