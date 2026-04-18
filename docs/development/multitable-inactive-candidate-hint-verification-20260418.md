## Verification Scope

Verified that inactive ACL candidate rows now explicitly explain why new grants are unavailable.

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

- inactive sheet candidate rows show `Inactive user`
- inactive sheet candidate rows show `Grant blocked`
- inactive record candidate rows show `Inactive user`
- inactive record candidate rows show `Grant blocked`
- existing disabled-grant behavior continues to pass

## Notes

- Existing frontend test noise may still print `WebSocket server error: Port is already in use`
- Existing Vite build warnings about chunk size / dynamic import remain unchanged
- No remote deployment was performed
- No database migration was added
