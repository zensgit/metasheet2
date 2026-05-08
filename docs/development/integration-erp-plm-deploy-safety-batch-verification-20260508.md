# ERP/PLM Deploy Safety Batch Verification - 2026-05-08

## Commit Under Test

- Branch: `codex/integration-deploy-safety-batch-docs-20260508`
- Base: `origin/main`
- Main head after batch: `2e038c36b009698f654b7c5b38806058d5dfa5e8`

## GitHub Fresh-Base CI Before Merge

Each merged PR was first updated with `gh pr update-branch`, then watched with `gh pr checks --watch --fail-fast=false`.

| PR | Result |
| --- | --- |
| #1377 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1378 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1376 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1374 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1372 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1360 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1361 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1363 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |
| #1367 | PASS: contracts, pr-validate, K3 WISE offline PoC, after-sales integration, Node 18, Node 20, coverage |

## Local Targeted Tests

Run from `/private/tmp/ms2-integration-deploy-safety-batch-20260508`.

```bash
node plugins/plugin-integration-core/__tests__/payload-redaction.test.cjs
node plugins/plugin-integration-core/__tests__/adapter-contracts.test.cjs
node plugins/plugin-integration-core/__tests__/runner-support.test.cjs
node plugins/plugin-integration-core/__tests__/erp-feedback.test.cjs
```

Result:

```text
PASS
payload-redaction, adapter-contracts, runner-support, and erp-feedback targeted tests passed.
```

```bash
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
node plugins/plugin-integration-core/__tests__/payload-redaction.test.cjs
node plugins/plugin-integration-core/__tests__/runner-support.test.cjs
```

Result:

```text
PASS
external-systems, http-routes, payload-redaction, and runner-support targeted tests passed.
```

```bash
bash -n scripts/ops/resolve-k3wise-smoke-token.sh
node --test scripts/ops/github-actions-runtime-readiness.test.mjs
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Result:

```text
PASS
github-actions-runtime-readiness: 7/7 tests passed
resolve-k3wise-smoke-token: 10/10 tests passed
integration-k3wise-postdeploy-workflow-contract: 2/2 tests passed
```

## Deploy Readiness Gate

Command:

```bash
node scripts/ops/integration-erp-plm-deploy-readiness.mjs \
  --head-sha 2e038c36b009698f654b7c5b38806058d5dfa5e8 \
  --format markdown \
  --output artifacts/integration-erp-plm-deploy-safety-20260508/readiness.md
```

Final result after the final merge batch and main workflow completion:

```text
PASS
Internal deployment: ready-for-physical-machine-test
Main workflow gates passed: Build and Push Docker Images, Plugin System Tests, Phase 5 Production Flags Guard, Deploy to Production.
Source gates passed: K3 setup checklist service/view, offline mock PoC chain, K3 postdeploy smoke.
Customer live remained blocked because customer GATE JSON was not provided.
```

Readiness artifact was written to `artifacts/integration-erp-plm-deploy-safety-20260508/readiness.md` in the local verification worktree. It is intentionally not part of the docs commit.

## Customer-Live Status

Customer-live ERP/PLM execution remains blocked by missing customer GATE information. Internal deployment readiness is evaluated separately from customer-live readiness; this prevents us from mixing "can deploy the feature" with "can connect to the customer's K3 WISE and PLM systems today."
