# Data Factory #2388 C0 source snapshot diff gate verification

Date: 2026-06-08

## Scope Verified

This PR is docs-only for issue #2388. It adds:

- `docs/development/data-factory-plm-stock-preparation-source-snapshot-diff-c0-design-20260608.md`
- a #2388 C0 section in
  `docs/development/data-factory-plm-project-bom-stock-preparation-execution-plan-todo-20260604.md`

It adds no runtime, route, UI, migration, package, worker, MetaSheet write, PLM
write, external database write, K3 path, raw SQL, or production rollout.

## Issue Grounding

The design was checked against the current #2388 issue and comments through the
GitHub REST API because GraphQL was intermittently returning EOF in this
workspace.

The locked #2388 scope is:

- design a generic Data Factory source snapshot/diff seam;
- implement only the PLM-BOM pilot in later slices;
- treat mark-inactive, human-field protection, and fresh dry-run token as
  already-shipped invariants to verify;
- add private source snapshots, source snapshot diff, and `missing_child_bom`;
- preserve a PLM `ComponentNode` + `BomEdge` internal shape;
- do not migrate the flat target idempotency-key scheme in this pilot.

## Code Grounding

Checked current helpers on `origin/main`:

- `plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs`
  currently performs app-side flat reads and recursively expands children. A
  childless component is treated as a leaf unless later slices add an explicit
  source completeness signal.
- `plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs`
  enforces `missingFromPlmPolicy='mark_inactive'` for v1.
- The conflict planner and apply writer both reject human-preserved fields in
  PLM/system write payloads.
- `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs`
  binds Apply to a server-issued dry-run token and revision check.

Therefore C0 scopes only the new source snapshot/diff and `missing_child_bom`
semantics, not a rebuild of the shipped invariants.

## Verification Commands

```bash
git diff --check
git diff --check HEAD~1..HEAD
```

Expected result: both commands pass after commit.

## Boundary Result

The design keeps public evidence values-free and routes future runtime into
separate opt-in slices. Production/batch remains gated by the large-BOM C3/C4
validation and production rollout gate.
