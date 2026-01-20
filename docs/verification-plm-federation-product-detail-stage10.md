# Verification - PLM Federation Product Detail Stage 10

## Scope

Verify Yuantus product detail mapping from AML get and search hit fallback.

## Preconditions

- `core-backend` running with `PLM_API_MODE=yuantus` and valid tenant/org/token.
- Yuantus backend reachable at `PLM_BASE_URL`.

## Steps

1. Query product detail by id.

   ```bash
   curl -s "$CORE_BASE_URL/api/federation/plm/products/$ITEM_ID" \
     -H "Authorization: Bearer $PLM_API_TOKEN"
   ```

2. Verify fields in response `data`:

   - `partNumber` is populated (from `properties.item_number` or aliases).
   - `itemType` reflects `type`/`item_type_id` from Yuantus.
   - `properties` exists and includes `item_number` when available.

3. (Optional) Query by item number to ensure search fallback merges detail:

   ```bash
   curl -s "$CORE_BASE_URL/api/federation/plm/query" \
     -H "Authorization: Bearer $PLM_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"products","search":"'$ITEM_NUMBER'","limit":1}'
   ```

## Results

- Run: 2026-01-19 (local)
  - Core: `http://127.0.0.1:7778`
  - Yuantus: `http://127.0.0.1:7910` (tenant-1/org-1)
  - Item ID: `b325aae4-280a-4b49-9a7c-54d1572d9e23`
  - Response: `ok=true`, `partNumber=CODX-1768834194-A`, `itemType=Part`
  - Search fallback: not run (optional step)
