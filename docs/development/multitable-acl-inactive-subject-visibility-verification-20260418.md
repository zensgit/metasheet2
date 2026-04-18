# Multitable ACL Inactive Subject Visibility Verification 2026-04-18

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- `pnpm install --frozen-lockfile`
  - passed
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts tests/multitable-record-permission-manager.spec.ts --watch=false`
  - `17/17 passed`
- `pnpm --filter @metasheet/web build`
  - passed

## Coverage of This Slice

- inactive users are marked in sheet ACL current-access rows
- inactive users are marked in sheet ACL candidate results
- inactive users are marked in record ACL current-access rows
- inactive users are marked in record ACL candidate results

## Known Non-Blocking Noise

- web build still prints the existing Vite dynamic-import warning
- web build still prints the existing chunk-size warning

## Deployment

- none
- frontend-only
- no database migration
