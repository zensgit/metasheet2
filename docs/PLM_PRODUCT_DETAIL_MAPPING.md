# PLM Product Detail Mapping

## Scope
Defines the product detail mapping for PLM adapters and the federation output used by the PLM view.

## Sources
- Adapter: `packages/core-backend/src/data-adapters/PLMAdapter.ts`
  - `mapYuantusItemFields()`
  - `mergeYuantusProductDetail()`
  - `mapProductFields()` (legacy)
- Federation: `packages/core-backend/src/routes/federation.ts`
  - `mapPLMProduct()`

## Core Fields (adapter -> federation)
| Field | Adapter source | Notes |
| --- | --- | --- |
| `id` | `item.id` | Always stringified |
| `name` | `properties.name` / `properties.item_name` / `item.name` | Falls back to `id` |
| `code` | `properties.item_number` / `properties.code` | Used for `partNumber` in federation |
| `version` | `properties.version` / `properties.revision` | Used for `revision` in federation |
| `status` | `item.state` / `properties.state` | Mapped from AML item state |
| `description` | `properties.description` | Optional |
| `itemType` | `item.type` (AML) | Item type, e.g. `Part` |
| `properties` | `item.properties` | Full raw property map |
| `created_at` | `item.created_on` / `properties.created_at` | ISO string |
| `updated_at` | `item.modified_on` / `properties.updated_at` | ISO string; falls back to `created_at` when missing |

## Yuantus Detail Merge
If AML detail lacks timestamps, the adapter fetches `/api/v1/search/` and merges:
- `created_at` from search hit `created_at`
- `updated_at` from search hit `updated_at`
- `name`, `code`, `version`, `status` filled when missing

## Legacy Product Mapping
Legacy adapters map:
- `code` from `internal_reference` or `code`
- `status` from `engineering_state` or `status`
- `created_at` from `created_at` or `create_date`
- `updated_at` from `updated_at` or `write_date`

## Federation Output (`mapPLMProduct`)
Federation adds UI-friendly aliases:
- `partNumber`: `product.code` fallback
- `revision`: `product.version` fallback
- `createdAt`: `product.created_at`
- `updatedAt`: `product.updated_at`

These fields are what the PLM view renders in the product detail panel.
