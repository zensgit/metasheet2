# Integration Watermark Value Guard Verification

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:runner-support
pnpm --dir plugins/plugin-integration-core run test:pipeline-runner
git diff --check
```

## Local Result

- `pnpm --dir plugins/plugin-integration-core run test:runner-support`: passed.
- `pnpm --dir plugins/plugin-integration-core run test:pipeline-runner`: passed.
- `git diff --check`: passed.

## Covered Cases

The runner-support suite now covers:

- existing idempotency key stability;
- existing `updated_at` and `monotonic_id` watermark derivation;
- normal set and advance behavior;
- monotonic watermark does not regress;
- invalid `updated_at` values are rejected before persistence;
- invalid `monotonic_id` values are rejected before persistence;
- invalid `advanceWatermark()` values are rejected before update;
- existing dead-letter and run-log support behavior remains unchanged.

## Residual Risk

This is a value validation guard. It does not change the database schema or add
tenant/workspace columns to `integration_watermarks`; the table still follows
pipeline scope as defined by migration 057.
