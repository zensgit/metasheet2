# Data Factory PLM Stock Preparation Source Snapshot Diff C0 Verification - 2026-06-08

## Scope

Docs-only verification for #2388 C0: PLM BOM source snapshot + diff gate before
incremental Apply.

## Reviewed Inputs

- Issue #2388 body and comments.
- Existing #2253 stock-preparation execution plan.
- Current C3 conflict planner and C4 apply writer contracts.
- Current C5 table-action dry-run/apply token and revision binding.
- #2342 large-BOM background expansion design dependency.
- #2343 duplicate-expanded-key D4 boundary.

## Code-Grounded Invariants

The C0 design treats these as shipped invariants to verify later, not rebuild:

- `missingFromPlmPolicy` is locked to `mark_inactive` in
  `stock-preparation-conflict-planner.cjs`.
- Human-owned fields are blocked from planner and writer payloads through
  `assertNoHumanFields`.
- Apply requires a dry-run token and revision match in
  `stock-preparation-table-actions.cjs`.

## Design Decisions Locked

- The snapshot/diff layer uses private in-tenant source structure.
- Public evidence is values-free.
- The generic seam is named, but runtime implementation stays PLM-BOM pilot
  first.
- PLM snapshot internals use `ComponentNode` + `BomEdge`.
- Node/edge identity must not migrate the existing flat target-table
  idempotency key in this pilot.
- Snapshot diff is latest source pull vs last applied source snapshot; it is
  not the same as the existing C3 target-table plan.
- `missing_child_bom` requires an explicit PLM assembly/expected-child signal
  or fails closed as held.

## Boundary

- No runtime code.
- No route/UI/migration/package/OpenAPI change.
- No snapshot storage implementation.
- No PLM write, external database write, raw SQL path, K3 path, or production
  rollout.

## Verification Commands

```bash
gh issue view 2388 --comments --json number,title,state,body,comments,url
rg -n "missingFromPlmPolicy|mark_inactive|assertNoHumanFields|dryRunToken|revision" \
  plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs \
  plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs \
  plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs
git diff --check
```

## Next Gates

- #2388 C1: snapshot storage contract/helper + invariant verification.
- #2388 C2: PLM-BOM snapshot builder using `ComponentNode` + `BomEdge`.
- #2388 C3: snapshot diff + category evidence.
- #2388 C4: `missing_child_bom` held branch.
- #2388 C5: apply gate integration with current snapshot/diff review.
