# Data Factory issue #1526 delivery readiness GATE contract verification - 2026-05-18

Companion to
`docs/development/data-factory-issue1526-delivery-readiness-gate-contract-design-20260518.md`.

## Verification matrix

| Check | Evidence | Result |
| --- | --- | --- |
| Stage 1 Lock held | Diff touches ops scripts, ops docs, tests, and development docs only. No `plugins/plugin-integration-core`, migration, backend route/API, or frontend runtime files. | PASS |
| CLI accepts GATE checker evidence | `integration-k3wise-delivery-readiness.mjs` accepts `--gate-contract-check <path>`. | PASS |
| Missing GATE checker evidence is pending | Unit test keeps existing Save-only readiness at `CUSTOMER_TRIAL_READY` when the new gate is not provided. | PASS |
| PASS GATE checker evidence is surfaced | Unit test shows the new gate as `pass` and carries O1-O6/R1-R7 answered counts. | PASS |
| GATE_BLOCKED evidence blocks readiness | Unit test maps checker `decision=GATE_BLOCKED` to readiness `BLOCKED`. | PASS |
| FAIL evidence blocks readiness | Unit test maps checker `decision=FAIL` to readiness `BLOCKED`. | PASS |
| Stage 1 Lock marker is enforced | Unit test rejects a checker report whose `stage1Lock.status` is not `held`. | PASS |
| CLI writes combined evidence | CLI test writes JSON/Markdown with `--gate-contract-check`; output contains a passing `gate-contract-check` gate. | PASS |
| Runbooks updated | Live GATE package, internal-trial runbook, and operator handoff include `--gate-contract-check`. | PASS |
| Package verifier guards this wiring | `multitable-onprem-package-verify.sh` now asserts the packaged readiness compiler and live GATE package mention `--gate-contract-check`. | PASS |
| Generated package proof | Local package build plus package verify passes against generated zip and tgz. | PASS |

## Commands run

```bash
node --check scripts/ops/integration-k3wise-delivery-readiness.mjs
node --check scripts/ops/integration-k3wise-delivery-readiness.test.mjs
pnpm verify:integration-k3wise:delivery
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
pnpm install --frozen-lockfile
PACKAGE_TAG=issue1526-delivery-gate-local INSTALL_DEPS=0 BUILD_WEB=1 BUILD_BACKEND=1 \
  scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue1526-delivery-gate-local.zip
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue1526-delivery-gate-local.tgz
git diff --check origin/main...HEAD
```

## Expected command results

| Command | Result |
| --- | --- |
| `node --check scripts/ops/integration-k3wise-delivery-readiness.mjs` | PASS |
| `node --check scripts/ops/integration-k3wise-delivery-readiness.test.mjs` | PASS |
| `pnpm verify:integration-k3wise:delivery` | PASS, 14/14 |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `pnpm install --frozen-lockfile` | PASS |
| `PACKAGE_TAG=issue1526-delivery-gate-local ... package-build.sh` | PASS |
| `multitable-onprem-package-verify.sh <generated zip>` | PASS |
| `multitable-onprem-package-verify.sh <generated tgz>` | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Manual command shape

```bash
node scripts/ops/integration-k3wise-delivery-readiness.mjs \
  --postdeploy-smoke artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --package-verify artifacts/integration-k3wise/delivery-readiness/package-verify.json \
  --gate-contract-check artifacts/integration-k3wise/gate-contract-check/integration-k3wise-gate-contract-check.json \
  --preflight-packet <packet-dir>/integration-k3wise-live-poc-packet.json \
  --out-dir artifacts/integration-k3wise/delivery-readiness/customer-ready \
  --fail-on-blocked
```

## GATE status

Customer GATE still blocks runtime implementation. This change does not make
WebAPI read/list, SQL sampling, or relationship resolving available; it only
lets the readiness artifact consume the customer-evidence checker report.
