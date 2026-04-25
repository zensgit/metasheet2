# Integration Core K3 WISE Live PoC Preflight Verification - 2026-04-25

## Scope

This verifies the M2 live PoC preflight packet generator.

The verification is local and does not contact customer PLM, K3 WISE, SQL Server, or a running MetaSheet backend.

## Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample
git diff --check -- scripts/ops/integration-k3wise-live-poc-preflight.mjs scripts/ops/integration-k3wise-live-poc-preflight.test.mjs docs/development/integration-core-k3wise-live-poc-preflight-design-20260425.md docs/development/integration-core-k3wise-live-poc-preflight-verification-20260425.md
```

## Expected Test Coverage

| Case | Expected result |
|---|---|
| Valid non-production GATE | Generates Save-only external systems, material pipeline, optional BOM pipeline, and checklist. |
| Production K3 environment | Fails before packet generation. |
| `autoSubmit` or `autoAudit` enabled | Fails because M2 live PoC is Save-only. |
| SQL Server write to K3 core tables | Fails unless channel is read-only. |
| BOM enabled without product scope | Fails and asks for `bom.productId` or PLM default product id. |
| Secret-bearing input | Generated JSON/MD do not contain submitted secret values. |

## Verification Result

| Check | Status | Evidence |
|---|---|---|
| Unit test | PASS | `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs` passed 6/6. |
| Sample generation | PASS | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample` output parsed as JSON. |
| Diff whitespace check | PASS | `git diff --check` exited 0 for the preflight script, test, and live PoC docs. |
| Integration plugin regression | PASS | `pnpm -F plugin-integration-core test` passed all plugin test files, including mock PLM to K3 WISE writeback. |
| Plugin manifest validation | PASS | `node --import tsx scripts/validate-plugin-manifests.ts` reported 13/13 valid, 0 errors. |

Test output summary:

```text
tests 6
pass 6
fail 0
duration_ms 46.430375
```

Plugin regression summary:

```text
plugin-runtime-smoke passed
host-loader-smoke passed
credential-store passed
db.cjs passed
external-systems passed
adapter-contracts passed
http-adapter passed
plm-yuantus-wrapper passed
pipelines passed
transform-validator passed
runner-support passed
payload-redaction passed
pipeline-runner passed
http-routes passed
k3-wise-adapters passed
erp-feedback passed
e2e-plm-k3wise-writeback passed
staging-installer passed
migration-sql passed
```

## Live PoC Boundary

Passing this verification only proves that the operator packet is structurally safe to prepare. It does not prove customer connectivity, K3 payload correctness, or PLM data quality.

The next live gate remains:

- archive real customer GATE answers;
- create external systems with credentials supplied out-of-band;
- run PLM and K3 `testConnection`;
- run material dry-run;
- run 1-3 Save-only material writes in the K3 WISE test account;
- capture feedback, dead letter, replay, watermark, and rollback evidence.
