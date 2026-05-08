# Integration Adapter Count Guard Verification

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:adapter-contracts
pnpm --dir plugins/plugin-integration-core run test:pipelines
git diff --check
```

## Local Result

- `pnpm --dir plugins/plugin-integration-core run test:adapter-contracts`:
  passed.
- `pnpm --dir plugins/plugin-integration-core run test:pipelines`: passed.
- `git diff --check`: passed.

## Covered Cases

The adapter-contract suite now covers:

- existing adapter registry behavior;
- existing read/upsert request normalization;
- existing upsert result defaults;
- numeric-string counters remain accepted;
- negative, fractional, `Infinity`, and `NaN` counters are rejected with
  `AdapterContractError`;
- unsupported operation helper behavior remains unchanged.

The pipelines suite confirms the stricter contract still works with pipeline
registry, endpoint, field-mapping, run-ledger, concurrent-run guard, and
stale-run cleanup tests.

## Residual Risk

This is a contract-boundary guard. It does not attempt to reconcile logically
inconsistent but valid counts, such as `written + skipped + failed` not matching
the input record count; those aggregate consistency checks belong in the
pipeline runner.
