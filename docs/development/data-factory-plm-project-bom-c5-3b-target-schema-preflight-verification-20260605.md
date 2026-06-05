# Data Factory PLM stock-preparation C5-3b target schema preflight verification (2026-06-05)

## Scope

C5-3b addresses the #2253 entity-machine smoke finding after C5-3a:

- the action config can now be injected and reports `configured:true`;
- dry-run reaches the C5 route;
- but a temporary target binding pointed at an existing stock-preparation table
  whose `target.fieldIdMap` omitted C5 PLM/system fields such as
  `idempotencyKey`, `path`, `active`, and `lastPlmRefresh*`.

This slice adds a values-free target config preflight. When an action uses an
explicit `target.fieldIdMap`, it must map every `plm_system` field from the
stock-preparation template. A partial explicit map fails closed with
`TARGET_SCHEMA_INCOMPLETE` before any PLM source adapter is loaded.

## Boundary

This slice does not add:

- support for `bridge:legacy-sql-readonly` as a C5 source kind;
- PLM reads;
- MetaSheet writes;
- K3 Save / Submit / Audit / BOM;
- migrations;
- UI changes;
- raw SQL;
- permission model changes.

The source contract remains `data-source:sql-readonly`. If the customer PLM can
only be reached through Bridge Agent, that is a separate source-design pivot,
not this hot path.

## Behavior

- Canonical C1 target tables may omit `target.fieldIdMap`; logical field ids are
  used as-is, preserving the existing happy path.
- Existing/non-canonical target tables that provide `target.fieldIdMap` are an
  explicit physical-field binding and must map all PLM/system fields.
- A missing PLM/system field returns `422 TARGET_SCHEMA_INCOMPLETE`.
- Error details are values-free and omit source ids and target sheet ids. They
  include only the target object id, field-map mode, required logical fields,
  and missing logical fields.
- The HTTP dry-run/apply routes run the target preflight before source adapter
  creation, so a bad target binding cannot trigger a PLM read.
- The helper APIs also run the same preflight, so direct unit/runtime calls
  cannot bypass the route guard.

## Verification

Commands run:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test:stock-preparation-apply-writer
pnpm --filter plugin-integration-core test
git diff --check
```

Results:

- `stock-preparation-table-actions.test.cjs`: passed.
- `http-routes.test.cjs`: passed.
- `stock-preparation-apply-writer.test.cjs`: passed.
- `plugin-integration-core test`: passed after installing workspace
  dependencies in the isolated worktree with
  `pnpm install --frozen-lockfile --offline`; node_modules shim churn was
  removed from the diff.
- `git diff --check`: passed.

## Test locks

`plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs`
locks the helper boundary:

- incomplete explicit target field maps fail with
  `TARGET_SCHEMA_INCOMPLETE`;
- dry-run fails before PLM source reads;
- apply fails before PLM source reads, target reads, target writes, or token
  consumption;
- the error reports missing logical field names without exposing the target
  sheet id.

`plugins/plugin-integration-core/__tests__/http-routes.test.cjs` locks the real
wire boundary:

- dry-run returns `422 TARGET_SCHEMA_INCOMPLETE`;
- missing `idempotencyKey` / `path` are surfaced as values-free logical field
  names;
- `getExternalSystemForAdapter` and `createAdapter` are never called when the
  target preflight fails;
- the error does not expose the configured source binding or target sheet id.

## Entity-machine retest closeout

The refreshed package
`metasheet-multitable-onprem-v2.5.0-plm-stock-c5-3b-17feef2f` was deployed on
the entity machine and the C5-3b guard passed:

- the temporary table-action config reached `configured:true`;
- a partial explicit `target.fieldIdMap` returned HTTP `422` with
  `TARGET_SCHEMA_INCOMPLETE`;
- the error exposed logical schema metadata only;
- the source-read log delta was `0`, proving the target preflight ran before any
  PLM/data-source read;
- no K3 Save / Submit / Audit / BOM, no MetaSheet apply/write, no external PLM
  DB write, and no raw/user-authored SQL were executed.

This closes the C5-3b code/package fix.

## Remaining gate

Full C5 smoke still needs two gates:

- target readiness: use a canonical C1 stock-preparation target or a complete
  explicit `fieldIdMap`; C1b owns the preferred canonical target
  provisioning/binding path;
- source readiness: bind the real PLM source as `data-source:sql-readonly`, or
  explicitly pivot to a separate source design if the Bridge Agent route is the
  desired production path.
