# K3 WISE SQL Disable Persist Verification - 2026-05-07

## Verification Plan

1. Run the focused K3 WISE setup helper tests.
2. Confirm SQL disabled with an existing system emits an inactive update payload.
3. Confirm SQL disabled without an existing system still emits `null`.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Expected Result

- Existing SQL system disabled -> minimal `erp:k3-wise-sqlserver` payload with `status: inactive`.
- New setup with SQL disabled -> `sqlServer: null`.
- Existing helper behavior remains green.

## Result

Passed locally on 2026-05-07.

- `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false` passed: 1 test file, 30 tests.
- `pnpm --filter @metasheet/web build` passed.
