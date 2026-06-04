# Data Factory PLM project BOM stock-preparation C1 manifest verification (2026-06-04)

## Scope

C1 for issue #2253. This is a schema-only, latent implementation slice:

- adds the stock-preparation main-table manifest contract;
- pins PLM/system-owned fields vs human-preserved fields;
- pins the default conflict strategy shape;
- encodes the C1/C2 BOM-read feasibility gate as a contract;
- adds focused tests.

It does not read PLM, write MetaSheet rows, add routes, add UI, run K3, or
provision a real sheet.

## Files

- `plugins/plugin-integration-core/lib/stock-preparation-templates.cjs`
- `plugins/plugin-integration-core/__tests__/stock-preparation-templates.test.cjs`
- `plugins/plugin-integration-core/package.json`
- `docs/development/data-factory-plm-project-bom-stock-preparation-execution-plan-todo-20260604.md`

## Locks

### Field model

The built-in `plm.stock-preparation.main.v1` manifest includes:

- idempotency/run/conflict PLM/system fields:
  `projectNo`, `idempotencyKey`, `componentSourceId`, `path`,
  `totalQuantity`, `active`, `lastPlmRefreshRunId`,
  `lastPlmRefreshDecision`, `lastPlmConflictSummary`;
- exact human-preserved whitelist:
  `materialType`, `blankType`, `stockPreparationStatus`, `demandDate`,
  `leadTimeDays`, `notes`, `procurementReply`, `warehouseConfirmation`;
- `config_info` option-source references for the human select fields, but no
  inline customer option values.

### Feasibility gate

The manifest encodes the C0 review finding as a hard schema gate:

- source kind must be `data-source:sql-readonly`;
- mode must be `flat_parameterized_reads`;
- match field must be `FileCode`;
- forbidden mechanisms must include `raw_sql`, `recursive_cte`,
  `stored_procedure`, and `vendor_api_call`;
- relation descriptors must include both `root_by_project` and
  `children_by_parent`;
- gate status starts as `requires_customer_schema`.

This does not pretend live PLM feasibility is already confirmed. It prevents C2
from proceeding without a flat-read relation contract and keeps the pivot rule
explicit: if the live PLM requires recursive CTE / stored procedure / vendor API,
v1 pivots to a customer flat BOM view or the deferred PLM adapter/API track.

### Schema-only safety

The normalizer rejects customer rows, values, payloads, raw SQL, stored
procedures, field defaults/options, and secret-shaped schema strings. The sheet
builder returns columns plus `rows: []`.

## Verification

Run:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-templates
pnpm --filter plugin-integration-core test:reference-mapping-templates
pnpm --filter plugin-integration-core test:staging
```

Expected: all pass.

## Next

C2 remains gated. It may only start after this C1 contract is reviewed and the
customer PLM relation descriptors are supplied or a customer flat BOM view is
chosen.
