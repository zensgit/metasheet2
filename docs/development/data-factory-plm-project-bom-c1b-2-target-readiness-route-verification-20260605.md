# Data Factory #2253 C1b-2 target readiness route verification (2026-06-05)

## Scope

C1b-2 exposes the C1b-1 canonical stock-preparation target helper through a
narrow backend workflow:

- `GET /api/integration/stock-preparation/target/readiness`
- `POST /api/integration/stock-preparation/target/ensure`

The routes are admin-only and use the C1 manifest as the target field contract.
They inspect/bind/create table and field metadata only.

## Boundaries

This slice does **not** add:

- frontend UI;
- PLM reads;
- MetaSheet business-row writes;
- C2/C3/C4 execution;
- K3 Save / Submit / Audit / BOM;
- external database writes;
- C6 custom option sync;
- source gate changes.

## Safety locks

- Permission is derived from `requireAccess(req, 'admin')`; the browser cannot
  supply `permission`.
- Request fields are allowlisted to `tenantId`, `workspaceId`, `projectId`, and
  `baseId`; `sheetId`, `fieldIdMap`, `target`, `source`, `plan`, and `payload`
  are rejected before provisioning.
- Missing targets can be created as metadata only through
  `context.api.multitable.provisioning.ensureObject`.
- Existing complete canonical targets bind without recreation.
- Existing incomplete canonical targets fail closed as
  `TARGET_SCHEMA_INCOMPLETE` and are not repaired in place.
- `data.evidence` is values-free. `data.targetBinding` is private admin config
  material and must not be pasted to issues/customer evidence.
- The route never uses `context.api.multitable.records`.

## Tests

```bash
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test:stock-preparation-target-provisioning
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
git diff --check
```

Expected focused output:

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
stock-preparation-target-provisioning.test.cjs OK
stock-preparation-table-actions.test.cjs OK
```

## Route assertions

`http-routes.test.cjs` covers:

- route registration for readiness and ensure;
- write user cannot inspect/ensure; provisioning API is not called;
- admin request with unsupported `sheetId` / `permission` fields returns
  `STOCK_PREPARATION_TARGET_REQUEST_INVALID` before provisioning;
- missing target readiness returns `canonical_missing` with values-free
  evidence;
- ensure creates the canonical descriptor and verifies manifest-derived fields;
- ensure existing complete canonical target returns `canonical_existing` without
  calling `ensureObject`;
- incomplete existing target returns `TARGET_SCHEMA_INCOMPLETE`, hides the
  sheet id, and is not repaired in place;
- records API call count stays zero across readiness/ensure paths.

## Remaining gates

- C1b-3: entity-machine target readiness smoke using the runbook.
- PLM source gate: real `data-source:sql-readonly` binding that satisfies C2
  flat reads.
- C5 full smoke: separate after target readiness and source gate pass.
- C6: custom option sync remains a later opt-in.
