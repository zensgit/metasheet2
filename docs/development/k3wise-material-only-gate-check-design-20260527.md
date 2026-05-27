# K3 WISE Material-Only Gate Check Design - 2026-05-27

## Purpose

Issue #1792 is the umbrella customer GATE for the K3 WISE live PoC. It must not
act as a global stop sign for lock-safe Data Factory work, but it must still
block K3 write expansion, BOM, Submit/Audit, and production signoff.

The immediate need is a smaller machine-checkable sub-gate for the current
Material-first path:

- verify that Material read/detail evidence is present and sanitized;
- verify that the first dry-run scope stays `FNumber` / `FName`;
- verify that BOM and Save-only are still separately gated;
- avoid requiring deferred BOM, relationship, pagination, list, or broad read
  evidence for this Material-only readiness check.

## Change

`scripts/ops/integration-k3wise-gate-contract-check.mjs` now supports:

```bash
--scope full
--scope material-only
```

`full` remains the default and preserves the existing O/R full GATE behavior.

`material-only` validates only:

- `webapiReadList.answers.O1-MAT`
- `webapiReadList.answers.O1-MAT-M`
- `webapiReadList.answers.O6`
- `webapiReadList.samples.materialDetail`
- `materialOnlySafety.answers.M0-SCOPE`
- `materialOnlySafety.answers.M0-PREVIEW-FIELDS`
- `materialOnlySafety.answers.M0-BOM-DEFERRED`
- `materialOnlySafety.answers.M0-SAVE-ONLY-SEPARATE-APPROVAL`
- `materialOnlySafety.answers.M0-AUTOSUBMIT-FALSE`
- `materialOnlySafety.answers.M0-AUTOAUDIT-FALSE`

The successful material-only decision is `PASS_MATERIAL_ONLY`, not `PASS`.
This makes the artifact usable for #1792 Material dry-run readiness without
being mistaken for the full customer GATE.

The `M0-PREVIEW-FIELDS` answer must explicitly mention `FNumber` and `FName`
so the sub-gate matches the current #1792 decision: first Material dry-run is
minimal and does not enable `FModel` or unit mapping.

## Boundaries

This change does not contact MetaSheet or K3 WISE.

It does not approve:

- K3 Save-only;
- K3 Submit;
- K3 Audit;
- BOM Save;
- relationship runtime;
- broad read/list, pagination, or filters;
- master-code resolver;
- server-side reference-object composition;
- production signoff.

Save-only remains behind separate explicit approval after Material dry-run
evidence and rollback ownership are confirmed.

## Compatibility

Existing callers do not need to change. If `--scope` is omitted, the checker
uses `full` and still requires the full O1-O6/R1-R7 evidence set.

The `material-only` report is intentionally not accepted as the existing full
delivery-readiness gate, because that readiness compiler checks for
`decision === "PASS"`.
