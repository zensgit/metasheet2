# Multitable Field And View ACL Governance Verification

## Targeted Frontend Tests
- Command:
  - `pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false`
- Result:
  - `12/12` passed

## Targeted Backend Integration
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-sheet-permissions.api.test.ts --watch=false`
- Result:
  - `38/38` passed

## Build
- Command:
  - `pnpm --filter @metasheet/core-backend build`
- Result:
  - passed

- Command:
  - `pnpm --filter @metasheet/web build`
- Result:
  - passed

## Coverage Highlights
- Verified field permission list responses hydrate member-group labels and subtitles.
- Verified view permission list responses hydrate member-group labels and subtitles.
- Verified selecting field `Default` removes the override through the client authoring call.
- Verified orphan field overrides remain visible and can be cleared.
- Verified orphan view overrides remain visible and can be cleared.
- Re-ran record permission manager coverage to confirm this slice did not regress adjacent ACL governance UI.

## Validation Scope
- No deployment was performed.
- No database migration was added or executed in this slice.
- Validation stayed scoped to field/view governance UI behavior, supporting backend permission list APIs, adjacent record governance UI regression coverage, and local builds.

## Known Non-Blocking Noise
- Frontend Vitest may print:
  - `WebSocket server error: Port is already in use`
- Backend integration still prints one existing formula recalculation stderr line in a write-own test path, but the suite passes.
- Web build still emits the existing Vite dynamic-import and chunk-size warnings.
