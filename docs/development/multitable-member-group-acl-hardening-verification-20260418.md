# Multitable Member-Group ACL Hardening Verification

## Targeted Unit Coverage
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-member-group-acl-hardening.test.ts --watch=false`
- Result:
  - `4/4` passed

## Targeted Integration Regression
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-sheet-permissions.api.test.ts tests/integration/multitable-context.api.test.ts --watch=false`
- Result:
  - `52/52` passed

## Build
- Command:
  - `pnpm --filter @metasheet/core-backend build`
- Result:
  - passed

## Validation Highlights
- Verified member-group sheet grants still resolve into effective sheet capabilities.
- Verified missing-table compatibility still returns an empty scope map for partial environments.
- Verified unexpected DB failures are no longer swallowed by `sheet-capabilities.ts`.
- Verified the main multitable sheet/context integration suite still passes after tightening the compatibility behavior.
- Verified the widening migration now covers `spreadsheet_permissions`, matching the runtime sheet ACL subject model.

## Validation Scope
- No frontend changes were made or tested in this slice.
- No deployment was performed.
- No migration was executed against a live database in this slice.

## Known Non-Blocking Noise
- Backend integration still prints one existing formula recalculation stderr line in a write-own test path, but the suite passes.
- The backend test runner still prints the existing Vite CJS deprecation notice before Vitest startup.
