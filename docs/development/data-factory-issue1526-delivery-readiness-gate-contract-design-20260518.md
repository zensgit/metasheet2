# Data Factory issue #1526 delivery readiness GATE contract design - 2026-05-18

## Purpose

The K3 WISE GATE contract checker now validates customer O1-O6 WebAPI read/list
answers and R1-R7 relationship mapping answers, but its result was separate from
the delivery readiness artifact.

This slice wires that checker report into
`scripts/ops/integration-k3wise-delivery-readiness.mjs` so the final handoff
record can say, in one place:

- the deployed MetaSheet smoke passed;
- the on-prem package was verified;
- the O1-O6/R1-R7 GATE contract evidence passed, is still pending, or blocks
  runtime work;
- the live preflight packet and live evidence remain Save-only safe.

## Scope

Changed:

- `scripts/ops/integration-k3wise-delivery-readiness.mjs`
- `scripts/ops/integration-k3wise-delivery-readiness.test.mjs`
- `docs/operations/integration-k3wise-live-gate-execution-package.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- this design note
- companion verification note

Not changed:

- no `plugins/plugin-integration-core`
- no K3 WebAPI read/list runtime
- no SQL executor/runtime
- no relationship resolver runtime
- no DB migration
- no frontend or backend route/API change

## CLI contract

`integration-k3wise-delivery-readiness.mjs` now accepts:

```bash
--gate-contract-check <path>
```

The input is the JSON report produced by:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --input <customer-contract-packet.json> \
  --out-dir artifacts/integration-k3wise/gate-contract-check
```

The expected report path is:

```text
artifacts/integration-k3wise/gate-contract-check/integration-k3wise-gate-contract-check.json
```

## Gate behavior

The readiness compiler adds a new gate:

```text
K3 read/list and relationship GATE contract
```

Behavior:

- missing report -> `pending`, does not block existing Save-only readiness;
- `decision=PASS` with `stage1Lock.status=held` -> `pass`;
- `decision=GATE_BLOCKED` -> `fail`, overall readiness `BLOCKED`;
- `decision=FAIL` -> `fail`, overall readiness `BLOCKED`;
- missing or non-held Stage 1 Lock marker -> `fail`.

The pending state is intentional. Existing customer Save-only readiness can
still be evaluated before O1-O6/R1-R7 arrive. Once the operator provides a GATE
contract report, incomplete or unsafe evidence must block runtime work.

## Output hygiene

The readiness artifact copies only compact counts from the GATE checker:

- summary pass/blocked/fail counts;
- WebAPI read/list answered/required counts;
- relationship mapping answered/required counts;
- the checker decision.

It does not copy raw customer samples, endpoint bodies, credentials, SQL
connection strings, bearer headers, or K3 session values.

## Package/runbook wiring

The live GATE execution package and operator handoff commands now include
`--gate-contract-check`.

The on-prem package verifier also asserts that:

- `integration-k3wise-delivery-readiness.mjs` exposes `--gate-contract-check`;
- the live GATE package documents `--gate-contract-check`;
- this design and verification note are included in the package.

## Stage 1 Lock

The Stage 1 Lock remains held. This change only connects evidence artifacts. It
does not implement read/list, SQL, or relationship runtime behavior.
