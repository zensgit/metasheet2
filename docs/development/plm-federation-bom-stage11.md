# PLM Federation BOM Stage 11

## Goal

Improve BOM integration by honoring depth/effective date, exposing refdes, and fixing substitute deletion path.

## Changes

- `getProductBOM` now accepts `depth` and `effectiveAt` and forwards `effective_date` to Yuantus.
- BOM flattening includes `find_num` and `refdes`, plus `part_number` fallback for component code.
- Substitute removal uses `/substitutes/{substituteId}` per Yuantus API.
- Federation routes pass `depth` and `effective_at` from GET and POST.

## Files Touched

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/src/routes/federation.ts`

