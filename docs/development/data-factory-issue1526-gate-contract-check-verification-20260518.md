# Data Factory issue #1526 GATE contract checker verification - 2026-05-18

Companion to
`docs/development/data-factory-issue1526-gate-contract-check-design-20260518.md`.

## Verification matrix

| Check | Evidence | Result |
| --- | --- | --- |
| Stage 1 Lock held | Diff touches ops script, tests, package script, and docs only. No `plugins/plugin-integration-core`, migration, backend route/API, or frontend runtime files. | PASS |
| Complete packet accepted | Unit test writes complete O1-O6/R1-R7 answers plus eight redacted sample files and asserts decision `PASS`. | PASS |
| Incomplete packet blocked | Unit test blanks `O1-BOM` and points one relationship sample at a missing file; report returns `GATE_BLOCKED` / exit 2. | PASS |
| Unsafe endpoint rejected | Unit test sets a read endpoint to an absolute URL; report returns `FAIL`. | PASS |
| Secret-shaped sample rejected | Unit test injects a raw password and access-token query into a sample; CLI exits 1. | PASS |
| Failure evidence does not echo raw secret | Secret regression asserts generated JSON does not contain the raw injected password or token value. | PASS |
| Customer manifests updated | WebAPI read/list and relationship manifests now point operators to the machine checker before runtime work. | PASS |

## Commands run

```bash
pnpm verify:integration-k3wise:gate-contract
node --check scripts/ops/integration-k3wise-gate-contract-check.mjs
node --check scripts/ops/integration-k3wise-gate-contract-check.test.mjs
git diff --check origin/main...HEAD
```

## Expected command results

| Command | Result |
| --- | --- |
| `pnpm verify:integration-k3wise:gate-contract` | PASS |
| `node --check scripts/ops/integration-k3wise-gate-contract-check.mjs` | PASS |
| `node --check scripts/ops/integration-k3wise-gate-contract-check.test.mjs` | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Sample operator command

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --input /path/outside-git/k3wise-gate-contract-packet.json \
  --out-dir artifacts/integration-k3wise/gate-contract-check
```

Expected decisions:

| Decision | Meaning |
| --- | --- |
| `PASS` | Packet is complete enough for post-GATE runtime planning, assuming the broader customer GATE is also PASS. |
| `GATE_BLOCKED` | Customer evidence is incomplete or sample shape is insufficient. |
| `FAIL` | Safety issue; fix/redact the packet before using it for development. |

## Scope boundary

This PR does not close #1526. It reduces the remaining runtime risk by making
the GATE-front contracts executable. K3 WebAPI read/list, SQL sample preview,
and relationship resolver runtime still require a separate post-GATE PR.
