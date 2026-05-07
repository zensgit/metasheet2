# K3 WISE SQL Server Table Scope - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:k3-wise-adapters
```

## Result

Passed.

## Coverage Added

- A table present only in `readTables` no longer authorizes `upsert()`.
- A table present only in `writeTables` no longer authorizes `read()`.
- Existing K3 WebAPI and SQL Server adapter coverage remains green.

## Residual Risk

This is a contract-level mock test. A live customer SQL Server PoC should still
verify the provisioned DB account permissions match the declared directional
allowlists.
