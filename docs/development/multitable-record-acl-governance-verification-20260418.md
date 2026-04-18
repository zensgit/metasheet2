# Multitable Record ACL Governance Verification

## Targeted Frontend Tests
- Command:
  - `pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false`
- Result:
  - `10/10` passed

## Targeted Backend Integration
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-sheet-permissions.api.test.ts --watch=false`
- Result:
  - `36/36` passed

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
- Verified record permission entries return hydrated member-group labels from the backend.
- Verified record permission manager renders hydrated labels and no longer depends on raw typed subject IDs.
- Verified record permission manager can grant:
  - user subjects
  - member-group subjects
- Verified record candidate search combines:
  - current sheet permission subjects
  - eligible sheet permission candidates

## Validation Scope
- No deployment was performed.
- No database migration was added or executed in this slice.
- Validation stayed scoped to the record-governance UI path, its supporting backend integration path, and local builds.

## Known Non-Blocking Noise
- Frontend Vitest may print:
  - `WebSocket server error: Port is already in use`
- Backend integration still prints one existing formula recalculation stderr line in a write-own test path, but the suite passes.
- Web build still emits the existing Vite dynamic-import and chunk-size warnings.
