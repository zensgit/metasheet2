# K3 WISE BOM Contract Hardening - Verification

Date: 2026-05-06
Branch: `codex/k3wise-bom-contract-20260506`

## Verified changes

### Transform contract

Command:

```bash
pnpm -F plugin-integration-core test:transform-validator
```

Result: passed.

Evidence:

- `FChildItems[].FItemNumber` and `FChildItems[].FQty` materialize to `FChildItems: [{ ... }]`.
- Validation can read the generated first child row through the same `[]` path.

### Runner source filters

Command:

```bash
pnpm -F plugin-integration-core test:pipeline-runner
```

Result: passed.

Evidence:

- `pipeline.options.source.filters.productId` reaches `sourceAdapter.read({ filters })`.
- Legacy flat `pipeline.options.source.productId` is not passed as source adapter option.
- Operator-owned `limit`, `cursor`, and `watermark` inside `options.source` are ignored so runner paging remains authoritative.
- Non-object `pipeline.options.source.filters` fails the run instead of silently dropping the customer BOM scope.

### PLM wrapper compatibility

Command:

```bash
pnpm -F plugin-integration-core test:plm-yuantus-wrapper
```

Result: passed.

Evidence:

- Existing direct `filters.productId` path still works in the PLM wrapper adapter.

### K3 adapter compatibility

Command:

```bash
pnpm -F plugin-integration-core test:k3-wise-adapters
```

Result: passed.

Evidence:

- WebAPI material/BOM adapter behavior and Save-only auto flag coercion are unchanged.

### E2E writeback compatibility

Command:

```bash
pnpm -F plugin-integration-core test:e2e-plm-k3wise-writeback
```

Result: passed.

Evidence:

- Existing mock PLM -> K3 WISE -> feedback writeback test still passes after runner and transform changes.

### Customer PoC chain

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result: passed.

Evidence:

- Preflight: 17/17 tests passed.
- Evidence compiler: 35/35 tests passed.
- Mock PoC demo:
  - material Save-only upsert wrote 2 records;
  - BOM Save-only upsert wrote 1 BOM;
  - mock K3 request body contained `FChildItems` as an array;
  - SQL readonly probe passed;
  - SQL core-table write was rejected;
  - compiled evidence returned `PASS` with 0 issues.

### Syntax checks

Command:

```bash
node --check scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
node --check scripts/ops/integration-k3wise-live-poc-preflight.mjs
node --check scripts/ops/integration-k3wise-live-poc-evidence.mjs
```

Result: passed.

### Full plugin test

Command:

```bash
pnpm -F plugin-integration-core test
```

Result: passed.

Note: the temporary worktree needed `pnpm install --frozen-lockfile --ignore-scripts` first so `node --import tsx` could resolve the host-loader smoke dependency. Generated dependency-link changes were cleaned before staging.

### Whitespace check

Command:

```bash
git diff --check
```

Result: passed.

## Deployment note

This is not a live deployment signoff. It proves the customer-runnable mock chain and plugin-local contracts. Real delivery still needs the customer GATE packet and a test-account K3 WISE live run.
