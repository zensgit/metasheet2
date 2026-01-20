# Verification - PLM Federation Error Handling Stage 12

## Scope

Validate that PLM adapter auth errors propagate to federation APIs.

## Preconditions

- `core-backend` running with `PLM_API_MODE=yuantus`.
- PLM base URL reachable.

## Steps

1. Use an invalid token (or omit token) and query products.

   ```bash
   curl -s -i "$CORE_BASE_URL/api/federation/plm/products" \
     -H "Authorization: Bearer invalid"
   ```

   Expected:
   - HTTP 401 (or 403 if upstream forbids).
   - JSON error with `code=PLM_UNAUTHORIZED` or `PLM_FORBIDDEN`.

2. Use valid auth and re-run the same request.

   ```bash
   curl -s "$CORE_BASE_URL/api/federation/plm/products" \
     -H "Authorization: Bearer $PLM_API_TOKEN"
   ```

   Expected:
   - HTTP 200 with `ok: true` and `data.items` populated.

3. Repeat for BOM or documents endpoints to confirm consistent behavior.

## Results

- Run: 2026-01-19 (local)
  - Core started with `PLM_API_TOKEN=invalid`
  - Request: `GET /api/federation/plm/products/b325aae4-280a-4b49-9a7c-54d1572d9e23`
  - Status: `401`
  - Error code: `PLM_UNAUTHORIZED`
