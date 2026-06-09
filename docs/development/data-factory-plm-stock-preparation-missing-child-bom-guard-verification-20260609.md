# Data Factory PLM stock-preparation missing-child BOM guard verification

Date: 2026-06-09

## Scope

This slice implements the minimal fail-closed guard required after #2402 before
the #2342 large-BOM runtime stack can produce authoritative expansion artifacts.

It changes the existing PLM BOM expansion helper only:

- active BOM head + zero BOM detail rows => `missing_child_bom`;
- the expansion becomes invalid / not applyable;
- the error is treated as source-incomplete, not as scale-bounded large-BOM;
- normal explicit-leaf behavior is preserved when there is no active BOM head.

No route, UI, migration, package, MetaSheet write, PLM write, external database
write, K3 path, raw SQL, stored procedure, production rollout, or checkpoint
writer behavior is added.

## Why

#2402 locked the source snapshot/diff semantics:

```text
childless component + explicit leaf signal -> complete leaf
childless component + explicit assembly/has-BOM signal -> missing_child_bom held
childless component + no usable signal -> held, not complete leaf
```

In the current read plan, an active BOM head is the available source-side
has-BOM signal. Before this slice, an active head with no detail rows silently
looked like a complete leaf. That would let a background large-BOM expansion
produce authoritative-looking artifacts for an incomplete assembly.

## Verification Commands

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-bom-expansion.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs
git diff --check
git diff --check origin/main...HEAD
```

## Test Coverage

The expansion test now covers:

- active BOM head with no details returns `valid:false` / `status:'failed'`;
- `rowErrors` contains `missing_child_bom`;
- public evidence exposes `errorTypes:['missing_child_bom']`;
- `largeBom:false`, so source incompleteness is not mislabeled as a scale cap;
- public evidence does not contain the sample project, component, or BOM id.

## Boundary Result

The guard is a prerequisite for re-reviewing #2393-#2401. It does not by itself
complete #2388 runtime, large-BOM background execution, checkpointed apply, or
production rollout.
