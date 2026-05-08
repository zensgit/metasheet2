# Integration ERP/PLM Current Deploy Readiness Verification - 2026-05-08

## Verification Plan

Run deterministic unit tests, render an offline markdown report, and run the live GitHub readiness command against `main`.

## Commands

```bash
node --test scripts/ops/integration-erp-plm-deploy-readiness.test.mjs
pnpm run verify:integration-erp-plm:deploy-readiness -- --head-sha <main-sha> --format markdown --output artifacts/integration-erp-plm-deploy-readiness.md
git diff --check
```

## Expected Result

- Unit tests pass.
- Offline fixture mode can produce PASS without calling GitHub.
- Live mode returns PASS only after the required workflows for the selected `main` SHA complete successfully.
- Customer live remains blocked unless a customer GATE JSON packet is supplied.

## Local Result

Completed on 2026-05-08.

### Unit Tests

```bash
node --test scripts/ops/integration-erp-plm-deploy-readiness.test.mjs
```

Result: passed, 8/8 tests.

Covered cases:

- option parsing, including the `pnpm run ... -- --flag` separator;
- required workflow PASS for the selected head SHA;
- failed, pending, and missing workflow gates;
- source marker failures;
- customer GATE JSON top-level detection;
- markdown report rendering and offline fixture mode.

### Live Main Readiness

Command:

```bash
pnpm run verify:integration-erp-plm:deploy-readiness -- --head-sha 3ce20f59a251e113cc88c5e20fc787de2cfce422 --format markdown --output artifacts/integration-erp-plm-deploy-readiness.md
```

Result: passed.

The generated report returned:

- Overall: `PASS`
- Internal deployment: `ready-for-physical-machine-test`
- Customer live: `blocked-until-customer-gate-and-test-account`

Workflow gates for `3ce20f59a251e113cc88c5e20fc787de2cfce422`:

- `Build and Push Docker Images`: PASS
- `Plugin System Tests`: PASS
- `Phase 5 Production Flags Guard`: PASS
- `Deploy to Production`: PASS

Source gates:

- K3 setup deploy checklist helper: PASS
- K3 setup deploy checklist view: PASS
- K3 offline mock PoC chain: PASS
- K3 postdeploy smoke script: PASS

### Offline K3 WISE PoC

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result: passed.

- Preflight tests: 18/18 passed.
- Evidence tests: 33/33 passed.
- Mock PLM/K3 WISE chain completed end-to-end with PASS.

### Diff Check

```bash
git diff --check
```

Result: passed.
