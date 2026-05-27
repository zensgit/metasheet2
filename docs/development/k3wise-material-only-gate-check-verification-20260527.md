# K3 WISE Material-Only Gate Check Verification - 2026-05-27

## Scope

This verifies the `--scope material-only` sub-gate added to
`scripts/ops/integration-k3wise-gate-contract-check.mjs`.

It is a tooling-only change. No plugin runtime, DB migration, API route,
frontend, K3 write, Submit/Audit, BOM, or broad read/list behavior is added.

## Commands

```bash
node --check scripts/ops/integration-k3wise-gate-contract-check.mjs
node --check scripts/ops/integration-k3wise-gate-contract-check.test.mjs
node scripts/ops/integration-k3wise-gate-contract-check.test.mjs
node scripts/ops/integration-k3wise-gate-contract-check.mjs --help
CHECK_DIR="$(mktemp -d /tmp/k3wise-material-only-template-check-XXXXXX)"
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template "$CHECK_DIR"
node scripts/ops/integration-k3wise-gate-contract-check.mjs --scope material-only --input "$CHECK_DIR/k3wise-gate-contract-packet.template.json" --out-dir "$CHECK_DIR/check-material-only"
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Script syntax | PASS |
| Test syntax | PASS |
| Gate checker test suite | PASS, 11/11 |
| Help output includes `--scope` | PASS |
| Template contains `materialOnlySafety.answers` | PASS |
| Unfilled template remains blocked in material-only mode | PASS, `decision=GATE_BLOCKED` |
| Package verifier marker | PASS, verifier now checks packaged checker contains `PASS_MATERIAL_ONLY` |
| Whitespace check | PASS |

## Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| Default full behavior remains unchanged | Existing full PASS and full blocked tests still pass with no `--scope` argument. |
| Material-only can pass without BOM/relationship/list/pagination evidence | `material-only scope passes without BOM, pagination, list, or relationship evidence`. |
| Material-only missing O1/O6/sample/safety inputs blocks | `material-only scope blocks missing material answers, safety answers, or material sample`. |
| Material-only rejects absolute URLs and secret query parameters | `material-only scope still rejects unsafe endpoints and query secrets`. |
| Material-only sample secret scan remains active | `material-only scope still scans material samples for secrets`. |
| Successful material-only decision cannot be confused with full PASS | Decision is `PASS_MATERIAL_ONLY`, and Markdown states this is not full customer GATE pass and does not approve K3 Save-only. |

## Boundary Confirmation

`PASS_MATERIAL_ONLY` means Material dry-run readiness only. It does not approve
K3 Save-only, Submit, Audit, BOM, broad read/list, server-side composition, or
production use.
