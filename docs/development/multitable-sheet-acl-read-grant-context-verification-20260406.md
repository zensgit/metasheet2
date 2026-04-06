# Multitable Sheet ACL Read Grant Context Verification

Date: 2026-04-06
Branch: `codex/multitable-sheet-acl-grant-read-20260406`

## Local Verification

### Backend integration

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts
```

Result:

- `17/17` tests passed

Verified scenarios include:

- read-only sheet scope still narrows context and record actions
- no global multitable permission + sheet `read` grant returns context
- no global multitable permission + sheet `write-own` grant returns context
- no global multitable permission + no sheet grant returns `403`

### Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

## Scope Notes

- No frontend code changed in this slice
- No OpenAPI contract changed in this slice
- No write-path ACL behavior changed in this slice
