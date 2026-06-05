# Data Factory PLM stock-preparation C5-3c source-gate smoke fixes verification (2026-06-05)

## Scope

C5-3c addresses the #2253 entity-machine Bridge-source smoke finding after the
`multitable-onprem-plm-stock-bridge-source-20260605-2d9281cdf` package:

- deploy and explicit `bridge:legacy-sql-readonly` action config passed;
- public table-action metadata stayed values-free;
- the first dry-run with C1b canonical target binding failed with
  `Unknown fieldId: projectNo`;
- a manually reconstructed complete `fieldIdMap` reached C2 expansion, but the
  first Bridge read failed with `read_failed` and insufficient values-free read
  diagnostics.

This slice fixes those two smoke blockers without opening writes.

## Runtime changes

- C1b canonical target readiness/ensure now returns a private
  logical-to-physical `targetBinding.fieldIdMap` from
  `multitable.provisioning.resolveFieldIds`.
- The values-free readiness evidence reports only whether that map is empty; it
  still does not expose sheet ids or physical field ids.
- C5 existing-row reads now work with the canonical C1b binding because
  `projectNo` filters are mapped to the physical target field id.
- Bridge adapter read metadata now reports values-free filter diagnostics:
  `filtersApplied` and `filterFields`.
- C2 BOM expansion evidence now reports values-free `readDiagnostics` with
  object name, filter field names, cursor presence, status, filters sent, adapter
  source when available, row count, and error code.

## Boundary

This slice does not add:

- MetaSheet apply/write;
- PLM/external database write;
- K3 Save / Submit / Audit / BOM;
- raw SQL, joins, CTEs, stored procedures, or vendor API calls;
- client-supplied target bindings;
- source fallback between `data-source:sql-readonly` and
  `bridge:legacy-sql-readonly`.

## Verification

Commands run:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-target-provisioning
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
node plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test
git diff --check
```

Results:

- `stock-preparation-target-provisioning.test.cjs`: passed.
- `stock-preparation-table-actions.test.cjs`: passed.
- `stock-preparation-bom-expansion.test.cjs`: passed.
- `bridge-agent-readonly-adapter.test.cjs`: passed.
- `http-routes.test.cjs`: passed.
- `plugin-integration-core test`: passed after installing workspace
  dependencies in the isolated worktree with `pnpm install --frozen-lockfile
  --offline`; node_modules shim churn was removed from the diff.
- `git diff --check`: passed.

## Test locks

`plugins/plugin-integration-core/__tests__/stock-preparation-target-provisioning.test.cjs`
locks the C1b target binding:

- existing canonical target binding returns the resolved logical-to-physical
  field map;
- create path returns the post-create resolved logical-to-physical field map;
- readiness evidence marks the map non-empty without exposing the private sheet
  id.

`plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs`
locks the C5 runtime use of that binding:

- dry-run with a complete physical `fieldIdMap` reads existing target rows using
  the physical project field;
- dry-run evidence remains values-free.

`plugins/plugin-integration-core/__tests__/stock-preparation-bom-expansion.test.cjs`
locks the source-gate diagnostics:

- successful reads expose `readDiagnostics[].filtersApplied=true` and filter
  field names without exposing project values or row values;
- read failures expose `readDiagnostics[].status=failed` and the adapter error
  code without copying the error message or business values.

`plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs`
locks the Bridge metadata:

- filtered reads POST primitive equality filters to the Bridge Agent;
- read metadata reports `filtersApplied=true` and sorted `filterFields`.

`plugins/plugin-integration-core/__tests__/http-routes.test.cjs` locks the
route-wire target binding:

- target readiness/ensure routes return the resolved private field map in
  `targetBinding`;
- values-free readiness evidence marks the map non-empty without exposing the
  private sheet id.

## Entity-machine retest

After this slice is packaged, rerun the #2253 source-gate smoke:

1. Deploy the refreshed package.
2. Configure the server-owned action source as `bridge:legacy-sql-readonly`.
3. Use the C1b target readiness `targetBinding` directly; do not manually
   reconstruct a field map from labels.
4. Run dry-run for one `projectNo`.
5. Capture values-free evidence only:
   - source kind;
   - projectNo present/not value;
   - dry-run status and counts;
   - expansion status/error types;
   - `readDiagnostics` object names, filter field names, filters sent/applied,
     status, and error code.

Do not paste targetBinding, sheet ids, source ids, physical field ids, PLM row
values, target row values, project values, raw SQL, connection strings, database
credentials, or Bridge shared secrets.
