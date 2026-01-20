# Verification - PLM Federation BOM Stage 11

## Scope

Validate BOM depth/effective date passthrough, refdes exposure, and substitute delete path.

## Preconditions

- `core-backend` running with `PLM_API_MODE=yuantus` and valid auth headers.
- Target BOM line with substitutes exists.

## Steps

1. BOM depth and effectivity.

   ```bash
   curl -s "$CORE_BASE_URL/api/federation/plm/products/$PARENT_ID/bom?depth=3&effective_at=2026-01-10" \
     -H "Authorization: Bearer $PLM_API_TOKEN"
   ```

   Confirm:
   - Response includes deeper children (level >= 2) when `depth=3`.
   - BOM items include `find_num` and `refdes` when present.

2. Substitute removal.

   ```bash
   curl -s -X POST "$CORE_BASE_URL/api/federation/plm/mutate" \
     -H "Authorization: Bearer $PLM_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"operation":"substitutes_remove","bomLineId":"'$BOM_LINE_ID'","substituteId":"'$SUB_ID'"}'
   ```

   Confirm:
   - API returns `ok: true` and the substitute is removed.

## Results

- Run: 2026-01-19 (local)
  - Core: `http://127.0.0.1:7778`
  - Parent ID: `b325aae4-280a-4b49-9a7c-54d1572d9e23`
  - BOM line: `63dc1b2f-faeb-41f7-b3ae-9cfe843463f2`
  - Substitute: `7c765c14-264b-4208-a670-e00492491bb8`
  - BOM: `ok=true`, `items=3`, `levels=[1,2]`, `refdes=true` (effective_at not set)
  - Substitute removal: `ok=true`, follow-up substitutes count `0`
