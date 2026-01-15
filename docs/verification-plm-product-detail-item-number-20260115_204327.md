# PLM Product Detail Item Number Fallback Verification (2026-01-15)

## Scope
- Yuantus product detail resolves by item number when AML lookup misses.
- Yuantus search hit matching now includes item_number and related property keys.
- Added unit coverage for item-number fallback path.

## Changes
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
  - search hit matching includes item_number + properties.
  - product detail falls back to search results when AML get returns empty.
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`
  - new test for item-number fallback.

## Verification
Command:
```
pnpm --filter @metasheet/core-backend test -- plm-adapter-yuantus.test.ts
```

Result:
- PASS (vitest executed full suite; 67 files / 864 tests)
- Exited watch mode after completion.
