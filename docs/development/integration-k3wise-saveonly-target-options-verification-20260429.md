# K3 WISE Save-Only Target Options Verification

## Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
node plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs
git diff --check
```

## Expected Result

- `pipeline-runner.test.cjs` proves `pipeline.options.target` is passed to
  `targetAdapter.upsert()` as `input.options`.
- The same runner suite keeps cleanse, idempotency, incremental, dead-letter,
  replay, ERP feedback, dry-run, pagination, status, coercion, and watermark
  regression coverage green.
- `k3-wise-adapters.test.cjs` continues to prove K3 WISE WebAPI per-request
  `autoSubmit` and `autoAudit` options override external-system config.
- The PLM -> K3 WISE writeback E2E remains green.
- Diff has no whitespace errors.

## Local Result

- `pipeline-runner.test.cjs`: pass.
- `k3-wise-adapters.test.cjs`: pass.
- `e2e-plm-k3wise-writeback.test.cjs`: pass.
- `git diff --check`: pass.

## Live PoC Impact

When the customer GATE packet is converted into a material or BOM pipeline, the
Save-only flags must be present under `pipeline.options.target`. The runner now
delivers those flags to the K3 adapter, so the PoC pipeline can force
`autoSubmit=false` and `autoAudit=false` even if a shared K3 external-system
record is later edited.
