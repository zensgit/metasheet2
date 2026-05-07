# Integration Runner Target Count Guard - Verification - 2026-05-07

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:pipeline-runner
```

## Result

Passed.

## Coverage Added

- A target adapter returning `written: Infinity`, `skipped: -1`, and
  `failed: "0"` now produces:
  - `run.status = partial`
  - `metrics.rowsWritten = 0`
  - `metrics.rowsFailed = 1`
  - `TARGET_WRITE_AGGREGATE_FAILED` dead letter
  - `invalidCounts = ["written", "skipped"]` in dead-letter evidence
  - no watermark advancement

## Residual Risk

This guard protects the runner accounting boundary. Adapter-specific contract
tests should still validate each vendor adapter's own result construction.
