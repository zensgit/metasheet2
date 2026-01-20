# PLM Federation Error Handling Stage 12

## Goal

Surface upstream auth/tenant/org errors from the PLM adapter instead of silently returning empty data.

## Changes

- Added shared `sendAdapterError` helper to map upstream status codes to API responses.
- Checked `result.error` for PLM query/mutate operations and returned proper status codes.
- Product list/detail/BOM handlers now return upstream auth errors when present.

## Files Touched

- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`

