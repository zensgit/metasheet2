# Data Factory #2343 D1 - duplicate-expanded-key dry-run evidence/UI verification (2026-06-06)

## Scope

This slice implements the D1 review surface for `duplicate_expanded_key` rows.

It remains read-only and dry-run-only:

- no duplicate policy persistence;
- no duplicate-row Apply;
- no MetaSheet row write;
- no PLM write;
- no external database write;
- no K3 path;
- no route, migration, package, or production rollout change.

## Backend evidence

`summarizeConflictPlanForEvidence()` now includes
`duplicateExpandedKeyDiagnostics` when the C3 planner finds duplicate expanded
keys.

The diagnostic is values-free and includes:

- `conflictType='duplicate_expanded_key'`;
- group count and duplicate-row count;
- rows-per-group distribution;
- same-parent / cross-parent / unknown parent-shape counts;
- quantity-shape counts (`all_equal`, `varied`, `unknown`);
- attribute-shape counts (`all_equal`, `varied`, `unknown`);
- stable-discriminator counts (`sourceDetail`, `pathParent`, `sortLine`);
- deterministic collision fingerprints;
- default policy `hold`;
- allowed policy names.

It does not expose raw idempotency keys, project numbers, PLM source ids,
component values, parent ids, paths, quantities, source detail ids, target row
values, sheet ids, field ids, credentials, raw SQL, or tokens.

## Workbench UI

`IntegrationWorkbenchView` now renders a grouped duplicate review block when the
dry-run evidence contains duplicate diagnostics:

- title: `重复行分组待处理`;
- manual-confirm badge;
- values-free metrics;
- policy candidate names;
- per-group ordinal/fingerprint/shape summary.

The UI does not add policy controls in D1. Duplicate rows remain held as
`manual_confirm`. Existing clean-row apply behavior is unchanged: an operator
can still explicitly accept that manual-confirm rows stay unwritten and apply
clean add/update/inactive rows.

## Verification

Commands:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
git diff --check
```

Covered assertions:

- duplicate expanded rows still produce `manual_confirm`;
- no duplicate group falls through to add/update/skip;
- evidence includes grouped duplicate diagnostics;
- diagnostics distinguish same-parent and cross-parent groups;
- diagnostics include quantity-shape and stable-discriminator counts;
- fingerprints are deterministic and do not expose raw keys;
- evidence does not contain project number, raw collision keys, component ids,
  component names, material, source detail ids, parent ids, or paths;
- the workbench renders the grouped duplicate block from a real dry-run
  response;
- the workbench block and evidence do not render project/component/material
  values or dry-run tokens;
- Apply remains disabled until the existing manual-confirm-hold acknowledgement
  is explicitly checked.

## Remaining gates

- D2: optional run/table-scoped policy persistence, owner/admin reviewed.
- D3: apply explicitly resolved duplicate rows, if approved.
- Entity-machine validation with values-free duplicate evidence.
