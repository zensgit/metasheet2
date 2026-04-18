## Verification Scope

Verified the inactive-candidate guard for multitable sheet and record ACL managers.

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

- inactive users still render in sheet ACL entries and candidate results
- inactive users still render in record ACL entries and candidate results
- inactive user candidate rows now disable the access-level selector
- inactive user candidate rows now disable the primary grant/apply action

## Notes

- Existing frontend test noise may still print `WebSocket server error: Port is already in use`
- Existing Vite build warnings about chunk size / dynamic import remain unchanged
- No remote deployment was performed
- No database migration was added
