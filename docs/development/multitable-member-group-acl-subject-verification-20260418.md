# Multitable Member Group ACL Subject Verification

## Targeted Frontend Tests
- Command:
  - `pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false`
- Result:
  - `9/9` passed

## Targeted Backend Integration
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-context.api.test.ts tests/integration/multitable-sheet-permissions.api.test.ts --watch=false`
- Result:
  - `49/49` passed

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
- Verified sheet permission entries and candidates now include `member-group`.
- Verified member-group candidates remain eligible even without direct user or role-level global multitable access.
- Verified effective sheet access can be derived from member-group grants.
- Verified sheet authoring endpoints accept `member-group` subjects.
- Verified sheet and record permission managers expose member-group options in the frontend and submit the expected payloads.

## Validation Scope
- No deployment was performed.
- No database migration was executed against a live environment.
- Validation remained scoped to targeted frontend tests, backend integration tests, and local package builds.

## Known Non-Blocking Noise
- Frontend Vitest may print:
  - `WebSocket server error: Port is already in use`
- One existing backend integration path still prints a formula recalculation stderr line for unhandled mock SQL, but the test passes.
- Web build still emits the existing chunk-size warning and dynamic import warning.
