# PLM Wrapper Input Normalization - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:plm-yuantus-wrapper
pnpm --dir plugins/plugin-integration-core run test:transform-validator
```

## Result

Passed.

## Coverage Added

- PLM material string fields are trimmed.
- whitespace-only material code/name are rejected.
- whitespace-only BOM `productId` is rejected before client invocation.
- BOM `quantity: true`, `false`, `[]`, `[2]`, and `{}` are rejected.
- transform `toNumber` rejects boolean, array, and object values.

## Residual Risk

This hardens generic input normalization. Vendor-specific PLM field dictionaries
may still need customer-specific validation rules once real GATE data arrives.
