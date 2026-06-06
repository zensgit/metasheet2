# Data Factory #2253 onsite closeout verification (2026-06-06)

## Scope

This document records the values-free onsite closeout for issue #2253 after the
PLM project BOM -> stock-preparation action was deployed and tested on the
entity machine.

It is a documentation-only closeout. It does not authorize another apply run,
production rollout, K3 action, external database write, or batch/multi-project
mode.

## Package / PR chain

| Step | PR / commit | Package / tag | Purpose |
|---|---:|---|---|
| Source gate + target/read diagnostics | #2313 / `61b13a95b` | `multitable-onprem-plm-stock-sourcegate-fixes-20260605-61b13a95b` | Bridge-source smoke fixes and values-free read diagnostics. |
| Filter receipt hardening | #2320 / `352ff069e` | `multitable-onprem-plm-stock-filter-receipt-20260605-352ff069e` | Trust real Bridge `filtersApplied` receipt, not request-derived evidence. |
| Option sync | #2326 / `fdec5af1c` | `multitable-onprem-plm-stock-c6-option-sync-20260605-fdec5af1c` | Sync stock-preparation option metadata and predefined action bindings. |
| Apply diagnostics | #2332 / `63b4416b` | `multitable-onprem-plm-stock-c4-diagnostics-20260606-63b4416b` | Values-free apply diagnostics for onsite troubleshooting. |
| Apply payload type fix | #2334 / `b637c019` | `multitable-onprem-plm-stock-c4-typefix-20260606-b637c019d` | Normalize C4 apply payload value types. |
| Planner comparison normalization | #2335 / `6035b185` | `multitable-onprem-plm-stock-c3-normalization-20260606-6035b185` | Normalize C3 comparisons so post-create readback plans as skip/update, not add. |

## Final onsite evidence

Evidence is intentionally values-free. Do not copy project numbers, PLM row
values, component names, material values, quantities, target row payloads, raw
SQL, connection strings, Bridge shared secrets, target bindings, sheet ids, or
physical field ids into issue/customer evidence.

| Check | Values-free result |
|---|---|
| C5/C2/C3 pre-apply dry-run | `rowsExpanded=44`, `add=44`, `manual_confirm=0`; no expansion error types. |
| C4 apply-only approved sample | `created=44`, `failed=0`. |
| Post-apply readback | `recordCount=44`. |
| Final #2335 dry-run after readback | `status=ready`, `planValid=true`, `existingRows=44`, `rowsExpanded=44`, `add=0`, `update=0`, `skip=44`, `inactive=0`, `manual_confirm=0`. |

The final dry-run proves the idempotency posture for this sample: the planner no
longer proposes duplicate `add` rows after the approved apply. `update` vs
`skip` can differ for benign representation normalization in future datasets;
the important duplicate-add signal is `add=0`.

## Stop rule

The #2253 sample is closed from the software side. Do not run C4 apply again for
this same sample.

A future apply requires a separate gate, for example:

- a new project/sample;
- a controlled production rollout;
- a batch/multi-project extension;
- a materially different source/target schema.

## Boundaries still closed

- No K3 Save / Submit / Audit / BOM.
- No PLM or external database write.
- No raw SQL, CTE, stored procedure, or vendor API escape hatch.
- No batch or multi-project mode.
- No old dry-run token reuse.
- No issue/customer evidence containing business row values.

## Remaining optional tracks

- Production rollout runbook and approval gate.
- New-project sample validation.
- Richer option authoring UI or option-trigger execution polish.
- Procurement/warehouse child-table generation.
- PLM adapter/API source, if the readonly SQL/Bridge path is insufficient.
- #2342 large-BOM strategy: bounded-preview readiness, background full
  expansion, and checkpointed apply for very large BOMs.
