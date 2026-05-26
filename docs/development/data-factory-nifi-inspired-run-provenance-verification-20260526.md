# Data Factory NiFi-Inspired Run Provenance Verification - 2026-05-26

## Scope

Verifies the design document only. This PR is docs-only and intentionally does
not implement a runtime, migration, connector, Data Factory UI, K3 write path,
or NiFi-style engine.

Design under verification:

- `docs/development/data-factory-nifi-inspired-run-provenance-design-20260526.md`

## Requirement matrix

| Requirement | Design coverage | Status |
|---|---|---|
| Keep MetaSheet multitable as the cleansing surface | Summary, Product decision, CleansingTable | PASS |
| Let users configure source system, target system, datasets, mappings, and run policies | User-authored configuration | PASS |
| Support same-system source and target with distinct datasets | DatasetDefinition notes | PASS |
| Borrow Apache NiFi ideas without copying the whole canvas/engine | Apache NiFi ideas to adapt, What we should not copy | PASS |
| Define run-level and row-level success/failure records | PipelineRun, RowResult | PASS |
| Include provenance/audit history | ProvenanceEvent | PASS |
| Include dead-letter/retry semantics | RowResult, Retry | PASS |
| Include back pressure and stop rules | Back pressure and stop rules | PASS |
| Preserve K3 locks | K3 WISE fit, Non-goals | PASS |
| Link to adjacent decisions and avoid doc drift | Relationship to adjacent Data Factory decisions | PASS |
| Keep later implementation phases gated | Phased implementation plan states only DF-N0 is covered and DF-N1+ require separate PR/gate review | PASS |
| Keep this slice docs-only | Scope, DF-N0, Non-goals | PASS |

## Local checks

Commands run from the repository root:

```bash
git diff --check origin/main...HEAD
```

Result:

```text
PASS
```

Secret-shape scan over the two new docs:

```bash
rg -n 'eyJ[A-Za-z0-9_-]+\.' docs/development/data-factory-nifi-inspired-run-provenance-*.md
rg -ni 'bearer\s+[A-Za-z0-9._-]+' docs/development/data-factory-nifi-inspired-run-provenance-*.md
rg -ni '(password|pwd)\s*[:=]\s*[^<\s]' docs/development/data-factory-nifi-inspired-run-provenance-*.md
rg -ni '(access_token|api_key|token|secret|sign|signature|session_id|auth)=[^&\s<]' docs/development/data-factory-nifi-inspired-run-provenance-*.md
```

Result:

```text
0 / 0 / 0 / 0
```

## Lock conformance

- No `apps/` changes.
- No `packages/` changes.
- No `plugins/` changes.
- No `scripts/ops/` changes.
- No `.github/workflows/` changes.
- No migration.
- No connector runtime.
- No K3 Save / Submit / Audit change.
- No server-pipeline reference auto-composition.
- No #1709 read/list runtime unlock.
- No automatic authorization to start DF-N2/DF-N3/DF-N4 implementation.

## Residual decisions

This document intentionally leaves implementation choices open:

- whether the first provenance implementation reuses existing integration logs
  or adds a new event table;
- which run policies become default per connector;
- whether retry starts as UI-only selected-row retry or a scheduled worker;
- whether K3 read/list is unlocked under the existing #1709 path.

Those are implementation PR decisions, not decisions made by this docs-only
slice.
