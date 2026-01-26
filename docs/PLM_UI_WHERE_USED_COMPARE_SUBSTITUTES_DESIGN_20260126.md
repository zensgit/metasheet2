# PLM UI Where-Used + BOM Compare + Substitutes Design (2026-01-26)

## Goal
Expose Yuantus PLM where-used, BOM compare, and BOM substitutes in the MetaSheet PLM UI via the federation API, keeping a consistent request/response contract for the frontend.

## Architecture
UI (PlmProductView.vue)
  -> Core backend federation routes (/api/federation/plm/query, /api/federation/plm/mutate)
  -> PLMAdapter (apiMode=yuantus)
  -> Yuantus PLM REST APIs

Authentication layers:
- MetaSheet UI -> Core backend: Bearer token (JWT)
- Core backend -> Yuantus PLM: Bearer token (YUANTUS) + x-tenant-id / x-org-id

## API Mapping

### Where-Used
- UI operation: `where_used`
- Federation route: `POST /api/federation/plm/query`
- Adapter call: `getWhereUsed(itemId, { recursive, maxLevels })`
- Yuantus endpoint: `GET /api/v1/bom/{item_id}/where-used?recursive=&max_levels=`
- Response shape:
  - `item_id`, `count`
  - `parents[]`: `{ parent, relationship, child?, line, line_normalized, level }`

### BOM Compare
- UI operation: `bom_compare_schema` + `bom_compare`
- Federation route: `POST /api/federation/plm/query`
- Adapter calls:
  - `getBomCompareSchema()` -> `/api/v1/bom/compare/schema`
  - `getBomCompare(params)` -> `/api/v1/bom/compare`
- Key parameters:
  - `left_id`, `right_id`
  - `left_type`, `right_type` (item | version)
  - `line_key`, `compare_mode`
  - `include_substitutes`, `include_effectivity`
  - `include_relationship_props`, `effective_at`
- Response shape:
  - `summary` (added/removed/changed)
  - `added`, `removed`, `changed` entries with line metadata

### Substitutes
- UI operation: `substitutes`, `substitutes_add`, `substitutes_remove`
- Federation route:
  - Query: `POST /api/federation/plm/query`
  - Mutate: `POST /api/federation/plm/mutate`
- Adapter calls:
  - `getBomSubstitutes(bomLineId)` -> `/api/v1/bom/{bom_line_id}/substitutes`
  - `addBomSubstitute(bomLineId, substituteItemId, properties)`
  - `removeBomSubstitute(bomLineId, substituteId)`
- Response shape:
  - `bom_line_id`, `count`, `substitutes[]`
  - `substitute_id` on add/remove

## UI Behavior Notes
- Where-used panel uses `whereUsedItemId`, `recursive`, `maxLevels`.
- BOM compare loads schema first for line-field mapping; compare uses left/right IDs.
- Substitutes panel uses BOM line ID derived from BOM table/tree selection.

## Required Environment Variables (core-backend)
- `PLM_API_MODE=yuantus`
- `PLM_BASE_URL=http://127.0.0.1:7910`
- `PLM_TENANT_ID=tenant-1`
- `PLM_ORG_ID=org-1`
- `PLM_USERNAME=admin`
- `PLM_PASSWORD=admin`
- `RBAC_TOKEN_TRUST=true` (dev-only, uses token claims without DB)
