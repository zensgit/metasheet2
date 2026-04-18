## Verification Scope

Verified the packaged inactive-subject governance follow-ups after replaying them onto the latest `main` that already includes `#902`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-sheet-permissions.api.test.ts tests/integration/multitable-context.api.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
```

## Results

- frontend vitest: `20/20 passed`
- frontend build: passed
- backend integration: passed
- backend build: passed

## Assertions Covered

- inactive candidates remain visible but cannot receive new grants
- inactive current sheet and record ACL rows are cleanup-only
- inactive field/view orphan overrides are visibly marked
- inactive candidate and cleanup-only states are explicitly explained in the UI
- existing member-group ACL integration coverage still passes on the new `main` base

## Notes

- Existing frontend test noise may still print `WebSocket server error: Port is already in use`
- Existing Vite build warnings about chunk size / dynamic import remain unchanged
- Existing backend integration stderr noise from formula recalculation may still appear without failing tests
- No remote deployment was performed
- No database migration was added in this package step
