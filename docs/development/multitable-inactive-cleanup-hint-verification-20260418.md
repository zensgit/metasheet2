## Verification Scope

Verified that inactive-user ACL entries now clearly display `Cleanup only` anywhere governance is limited to removal/cleanup.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- `vitest`: `20/20 passed`
- `web build`: passed

## Assertions Covered

- inactive current sheet ACL rows show `Cleanup only`
- inactive current record ACL rows show `Cleanup only`
- inactive field template rows show `Cleanup only`
- inactive field override rows show `Cleanup only`
- inactive view template rows show `Cleanup only`
- inactive view override rows show `Cleanup only`

## Notes

- Existing frontend test noise may still print `WebSocket server error: Port is already in use`
- Existing Vite build warnings about chunk size / dynamic import remain unchanged
- No remote deployment was performed
- No database migration was added
