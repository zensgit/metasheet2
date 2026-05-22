# K3 WISE GATE Contract Customer Handoff README Verification - 2026-05-22

## Scope

This verification covers the `--init-template` addition that writes
`README-CUSTOMER-HANDOFF.zh.md` next to the GATE contract packet.

Stage 1 Lock status: held. The change is ops/test/docs only and does not touch
integration-core runtime, migrations, API routes, frontend routes, K3 calls, or
pipeline execution.

## Local Verification

| Command | Result |
| --- | --- |
| `pnpm verify:integration-k3wise:gate-contract` | PASS: 5/5 tests |
| `node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template /tmp/k3wise-gate-contract-readme-test-20260522` | PASS: `decision=TEMPLATE_CREATED`, `sampleCount=8`, `readmePath` present |
| `node scripts/ops/integration-k3wise-gate-contract-check.mjs --input /tmp/k3wise-gate-contract-readme-test-20260522/k3wise-gate-contract-packet.template.json --out-dir /tmp/k3wise-gate-contract-readme-test-20260522/check-initial` | PASS: exit `2`, `decision=GATE_BLOCKED`, summary `0 pass / 23 blocked / 0 fail` |
| secret-shape scan over generated packet directory | PASS: 0/5 patterns matched |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Regression Coverage

The focused gate-contract test now verifies:

- `--init-template` stdout lists `README-CUSTOMER-HANDOFF.zh.md`;
- the README file exists in the generated directory;
- the README contains the expected customer-facing markers:
  - `K3 WISE GATE`;
  - `O1-MAT`;
  - `O1-BOM`;
  - `R1`;
  - `R7`;
  - the no Save/Submit/Audit boundary;
- the README does not contain JWT-shaped values, Bearer headers, credentialed
  database URLs, or secret-looking URL query parameters.

## Manual Template Smoke

The generated packet must still be blocked before the customer fills it:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --input /tmp/k3wise-gate-contract-readme-test-20260522/k3wise-gate-contract-packet.template.json \
  --out-dir /tmp/k3wise-gate-contract-readme-test-20260522/check-initial
```

Expected result:

- exit code `2`;
- decision `GATE_BLOCKED`;
- no `FAIL`;
- no secret-shape findings.

## Residual Risk

This README improves handoff repeatability only. It does not validate customer
business semantics and does not replace maintainer review of the filled packet.
The post-GATE runtime work for #1709 and #1711 still requires a filled packet
that returns `PASS`.
