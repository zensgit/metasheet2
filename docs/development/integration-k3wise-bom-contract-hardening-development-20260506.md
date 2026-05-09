# K3 WISE BOM Contract Hardening - Development Notes

Date: 2026-05-06
Branch: `codex/k3wise-bom-contract-20260506`

## Goal

Close the remaining mock-to-live gap in the PLM -> MetaSheet cleanse -> K3 WISE BOM path before customer GATE answers arrive.

The slice is deliberately narrow:

- pass BOM source scope through the runner as adapter `filters`, not a legacy flat option;
- materialize K3 child-table paths such as `FChildItems[].FItemNumber` into a real array payload;
- require successful BOM evidence to prove a real Save-only run and K3 response;
- keep the PR conflict-light by avoiding `package.json` and the K3 WISE runbook currently touched by PR #1355.

## Problem

Three boundaries were still too soft for live BOM PoC:

1. `pipeline.options.source.filters.productId` was emitted by preflight but not passed into `sourceAdapter.read()`. The PLM wrapper already supports `filters.productId`, so the runner was the missing handoff.
2. `transform-engine` treated `FChildItems[]` as a literal object key. K3 WISE BOM Save expects `FChildItems: [{ ... }]`.
3. `bomPoC.status = pass` could pass evidence with only `productId` and the legacy-path flag. That proved scope intent, not an actual BOM Save-only run or K3 response.

## Implementation

### Runner source read options

File: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

- Added `resolveSourceReadOptions(pipeline)`.
- Passes `pipeline.options.source.filters` to `sourceAdapter.read({ filters })`.
- Passes non-reserved source options to `sourceAdapter.read({ options })`.
- Drops legacy/reserved keys from source options:
  - `productId`
  - `product_id`
  - `filters`
  - `limit`
  - `cursor`
  - `watermark`
- Fails loudly when `pipeline.options.source` or `pipeline.options.source.filters` is present but not an object.

This keeps runner-owned paging and watermark state authoritative.

### BOM child-table transform paths

File: `plugins/plugin-integration-core/lib/transform-engine.cjs`

- Added parsed path segments with `[]` awareness.
- `setPath(record, 'FChildItems[].FItemNumber', 'MAT-002')` now produces:

```json
{
  "FChildItems": [
    {
      "FItemNumber": "MAT-002"
    }
  ]
}
```

- `getPath()` now reads the first array item for the same path shape, so validation can check generated child-table values.
- Existing unsafe path protections still apply to the actual key segment.

Current scope intentionally supports one child row per transformed source record. Multi-child aggregation remains a future adapter or transform feature if the customer needs tree-to-document grouping.

### Preflight and fixture contract

Files:

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/gate-sample.json`

Changes:

- BOM mappings now require a K3 BOM number target (`FNumber`).
- Sample BOM mappings use:
  - `FNumber`
  - `FParentItemNumber`
  - `FChildItems[].FItemNumber`
  - `FChildItems[].FQty`
- Sample material mapping no longer emits unsupported `upperTrim`; it uses `['trim', 'upper']`.
- Sample material UOM mapping no longer emits unsupported `dictMap` args.
- Added a preflight test that sends sample mappings through `transformRecord()`, so future samples cannot drift away from the runtime transform engine.

### Evidence contract

Files:

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/evidence-sample.json`

When `bomPoC.status` normalizes to `pass`, evidence now requires:

- `bomPoC.productId`
- `bomPoC.runId`
- `bomPoC.rowsWritten` between 1 and 3
- at least one `bomPoC.k3Records[]`
- at least one K3 response id: `externalId` or `billNo`
- no legacy `pipeline.options.source.productId` usage

New issue codes:

- `BOM_RUN_ID_REQUIRED`
- `BOM_ROW_COUNT`
- `BOM_K3_RECORD_REQUIRED`
- `BOM_K3_RESPONSE_REQUIRED`

### Mock PoC demo

File: `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

The demo now performs a real mock K3 BOM Save-only upsert:

- object: `bom`
- one BOM record
- `FChildItems` is asserted to be an array in the mock K3 request body
- evidence is populated from the returned BOM upsert result

That means `pnpm run verify:integration-k3wise:poc` proves both material and BOM Save-only evidence paths before customer credentials are available.

## Conflict posture

This branch intentionally does not edit:

- `package.json`
- `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
- K3 WebAPI adapter internals
- mock K3 server internals

Reason: PR #1355 is still open and touches the runbook/package area. This slice stays focused on the runner, transform contract, fixtures, tests, and generated development evidence.

## Remaining work

- Customer live GATE answers are still required before running against real PLM/K3 WISE.
- Real K3 WISE may require customer-specific BOM grouping or extra fields beyond this one-row child-table payload.
- If live K3 returns a different success identifier than `externalId` or `billNo`, the K3 response parser/evidence compiler should be extended from live evidence rather than guessed now.
