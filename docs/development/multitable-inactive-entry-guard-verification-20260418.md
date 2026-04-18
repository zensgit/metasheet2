## Verification Scope

Verified that inactive-user ACL entries are now cleanup-only across sheet, record, field, and view governance surfaces.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- `vitest`: `19/19 passed`
- `web build`: passed

## Assertions Covered

- inactive sheet ACL entries remain visible
- inactive record ACL entries remain visible
- inactive sheet and record current-entry rows now disable mutation controls
- inactive sheet field/view template rows now disable bulk-apply controls
- inactive sheet field/view per-row overrides now disable save controls
- inactive-user cleanup actions remain available through remove / clear paths

## Notes

- Existing frontend test noise may still print `WebSocket server error: Port is already in use`
- Existing Vite build warnings about chunk size / dynamic import remain unchanged
- No remote deployment was performed
- No database migration was added
