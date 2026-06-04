# Data Factory PLM stock-preparation C5-2 workbench action UI verification (2026-06-04)

## Scope

C5-2 wires the already-merged C5-1 table-action routes into the Data Factory
workbench UI.

The operator can:

- select the configured `plm.stock-preparation.pull-bom.v1` action;
- enter the allowlisted `projectNo` parameter;
- run a dry-run;
- review status/counts and values-free evidence;
- apply only with the server-issued dry-run token and explicit confirmation when
  `manual_confirm` rows are held.

## Boundary

This slice is frontend/service wiring only.

It does not add:

- raw SQL input;
- source/object/read-plan editing;
- browser-supplied `sheetId`;
- browser-supplied C3 plan or C4 payload;
- K3 Save / Submit / Audit / BOM action;
- batch or multi-project mode.

The action config remains server-side/admin-owned. The browser sends only
`parameters` and, for apply, `confirm`.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
git diff --check
```

Results:

- `IntegrationWorkbenchView.spec.ts`: 19/19 passed.
- `vue-tsc -b`: passed.
- Existing web lint script: passed.
- `git diff --check`: passed.

## Test Locks

`apps/web/tests/IntegrationWorkbenchView.spec.ts` locks the C5-2 request body:

- dry-run sends `{ parameters: { projectNo } }`;
- apply sends `{ parameters: { projectNo }, confirm: { dryRunToken,
  acceptManualConfirmHold } }`;
- both requests are asserted to omit `sheetId`, `source`, `target`, `plan`, and
  `payload`;
- apply stays disabled until a dry-run token exists;
- `manual_confirm` rows require explicit hold confirmation before apply;
- the dry-run token is used by the request but is not rendered into the panel;
- evidence remains values-free and does not contain the project number or token.

## Remaining Gate

C5-3 remains a separate opt-in: an operator validation runbook / entity-machine
smoke for one project dry-run and, only with explicit approval, one apply to the
configured MetaSheet stock-preparation main table.

