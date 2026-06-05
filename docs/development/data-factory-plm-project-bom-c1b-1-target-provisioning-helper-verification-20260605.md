# Data Factory #2253 C1b-1 target provisioning helper verification (2026-06-05)

## Scope

C1b-1 adds a latent backend helper for canonical PLM stock-preparation target
readiness/provisioning:

- build a MetaSheet object descriptor from `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`;
- bind an existing canonical target when all logical fields are present;
- create a missing canonical target as metadata only through
  `context.api.multitable.provisioning.ensureObject`;
- return a server-side target binding with empty `fieldIdMap` because logical
  field ids match the canonical manifest;
- emit values-free readiness evidence.

It does not add a route, UI, migration, PLM read, MetaSheet row write, K3 path,
external DB write, or C6 option sync.

## Safety locks

- Admin permission is required before any provisioning read/create call.
- Missing `multitable.provisioning` fails closed.
- Existing incomplete canonical targets fail closed as `TARGET_SCHEMA_INCOMPLETE`
  and are not repaired in place.
- Missing targets are created as table/field metadata only; the helper never uses
  `context.api.multitable.records`.
- Creation is verified by a post-create logical-field lookup via
  `resolveFieldIds`; it does not trust `ensureObject`'s returned physical field
  ids.
- Readiness evidence contains mode/status/field counts/missing logical field ids
  and option-source keys only; it does not expose target sheet ids, physical
  field ids, business row values, PLM row values, datasource ids, credentials, or
  action config JSON.

## Tests

```bash
pnpm --filter plugin-integration-core test:stock-preparation-target-provisioning
pnpm --filter plugin-integration-core test:stock-preparation-templates
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
git diff --check
```

Expected focused output:

```text
stock-preparation-target-provisioning.test.cjs OK
stock-preparation-templates.test.cjs OK
stock-preparation-table-actions.test.cjs OK
```

## Negative controls

`stock-preparation-target-provisioning.test.cjs` locks the failure classes that
matter for C1b:

- non-admin permission rejects before `findObjectSheet`;
- incomplete existing target rejects and never calls `ensureObject`;
- records API calls throw in the fake context and the suite stays green, proving
  C1b-1 writes no rows;
- create path must call `resolveFieldIds` after `ensureObject`; a post-create
  missing logical field returns `TARGET_SCHEMA_INCOMPLETE`.

## Remaining gated slices

- C1b-2: optional admin UI/runbook to create or bind the canonical target.
- C1b-3: entity-machine target readiness smoke.
- C6: controlled custom-option sync for configured select fields.
- C5 full smoke still also requires the separate PLM source gate.
