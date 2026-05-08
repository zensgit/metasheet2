# K3 WISE BOM And Sample-Limit Closeout Verification - 2026-05-08

## Commits Under Test

- #1358 merge commit: `d8cd53227679d0639c7394137a4fbd3cbcaecc48`
- #1369 merge commit: `a7805767a5c50239e7a756a36e0ead0eff700db4`

## Review

Two parallel read-only reviews were used before merge:

- #1358 review result: merge after fresh CI; no blocking change required. Main noted boundary is that `FChildItems[]` supports one child row per source record, not multi-row BOM aggregation.
- #1369 review result: merge after #1358 and fresh CI; no blocking change required. Main noted non-blocking UI detail is that service validation enforces the cap even though the input remains text-like.

## Local Verification

Run from isolated worktrees under `/private/tmp`.

```bash
node plugins/plugin-integration-core/__tests__/transform-validator.test.cjs
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
node plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs
```

Result:

```text
PASS
transform-validator, pipeline-runner, and e2e PLM -> K3 WISE writeback tests passed.
```

```bash
node --check scripts/ops/integration-k3wise-live-poc-preflight.mjs
node --check scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Result:

```text
PASS
live PoC preflight/evidence: 57/57 tests passed.
mock K3 WISE PoC chain passed, including BOM Save-only payload with FChildItems.
```

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
```

Result:

```text
PASS
apps/web tests/k3WiseSetup.spec.ts: 25/25 tests passed.
```

## GitHub Fresh-Base CI

Both PR branches were updated to current main before merge.

| PR | Result |
| --- | --- |
| #1358 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1369 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Observability E2E, Node 18, Node 20, coverage. Strict E2E skipped by workflow condition. |

## Main Deploy Readiness

Command:

```bash
node scripts/ops/integration-erp-plm-deploy-readiness.mjs \
  --head-sha a7805767a5c50239e7a756a36e0ead0eff700db4 \
  --format markdown \
  --output artifacts/k3wise-bom-sample-closeout-readiness.md
```

Result:

```text
PASS
Internal deployment: ready-for-physical-machine-test
Main workflow gates passed: Build and Push Docker Images, Plugin System Tests, Phase 5 Production Flags Guard, Deploy to Production.
Source gates passed: K3 setup checklist service/view, offline mock PoC chain, K3 postdeploy smoke.
Customer live remained blocked because customer GATE JSON was not provided.
```

## Remaining Customer Gate

Internal testing can continue on a deployed physical machine. Customer-live testing remains blocked until customer GATE information is present:

- K3 WISE version and safe test account.
- K3 WebAPI or channel base URL.
- PLM material and BOM source fields.
- SQL Server permission boundary or integration database.
- Rollback owner and evidence expectations.
