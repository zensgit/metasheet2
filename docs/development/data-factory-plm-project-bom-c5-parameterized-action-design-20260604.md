# Data Factory #2253 C5 - parameterized stock-preparation action design (2026-06-04)

> **Design-first. No runtime in this slice.** This document locks the C5
> contract for issue #2253 after C2/C3/C4 landed: expose the PLM project BOM
> refresh as a reusable, parameterized table action in the workbench. The first
> configured action is the stock-preparation BOM pull. This design adds no
> route, no UI, no migration, no package change, no PLM/K3 write, and no
> MetaSheet write.

## Current state

The backend pieces are now latent and test-locked:

- C2-0 filters `data-source:sql-readonly` reads with equality-only `where`
  filters.
- The explicit Bridge-source follow-up allows the same C5 action contract to
  read from `bridge:legacy-sql-readonly` when the server-side action config
  names that kind and the saved external system has the same kind. This is not a
  silent fallback from the generic data-source path.
- C2 expands one `projectNo` into normalized stock-preparation candidate rows
  through app-side flat reads.
- C3 plans `add`, `update`, `skip`, `inactive`, and `manual_confirm` decisions
  while preserving human-owned fields.
- C4 applies an accepted plan to one configured stock-preparation main table
  through an injected MetaSheet records API.

C5 is the first slice that connects those helpers to an operator surface. That
means C5 must be more than a one-off button, but it must still stay narrow:
operators fill approved parameters; they never edit source bindings, target
sheet ids, filters, mappings, raw SQL, or writer payloads.

## Product shape

Add a reusable **parameterized table action** surface in Data Factory:

```text
admin-reviewed action config
        |
operator fills allowlisted parameters
        |
dry-run: C2 expansion -> C3 conflict plan
        |
operator reviews counts/conflicts
        |
apply: server recomputes plan -> C4 writer
```

The first action instance is:

```text
plm.stock-preparation.pull-bom.v1
```

It accepts one operator parameter:

| Parameter | Required | Binding | Notes |
|---|---:|---|---|
| `projectNo` | yes | exact equality on PLM `FileCode` | trimmed string; no fuzzy/prefix/batch in v1 |

The UI may display tenant business values to authorized users in the normal
workspace surface. Issue/customer evidence must stay values-free.

## Action contract

The reusable action config is tenant/workspace scoped and admin-reviewed.
Creating or editing an action config is admin-only, because the config binds the
trusted source, read plan, and target stock-preparation sheet. The
operator-facing request carries only `actionId` and parameter values.

Shape:

```json
{
  "actionId": "plm.stock-preparation.pull-bom.v1",
  "kind": "parameterized_table_action",
  "label": "PLM project BOM -> stock preparation",
  "source": {
    "externalSystemId": "ext_plm_readonly",
    "kind": "data-source:sql-readonly",
    "readPlanId": "plm.stock-preparation.bom-read.dn-pdm.v1"
  },
  "target": {
    "sheetId": "stock-preparation-main-sheet",
    "objectId": "stockPreparationMain",
    "keyField": "idempotencyKey",
    "fieldIdMap": {}
  },
  "parameters": [
    {
      "id": "projectNo",
      "label": "Project number",
      "type": "string",
      "required": true,
      "trim": true,
      "binding": {
        "type": "equality_filter",
        "field": "FileCode"
      }
    }
  ],
  "permissions": {
    "dryRun": "read",
    "apply": "write"
  },
  "evidence": {
    "valuesFreeIssueEvidence": true
  }
}
```

Hard locks:

- `kind` is enum-strict. Unknown action kind fails closed.
- The action source must be one of:
  - `data-source:sql-readonly`;
  - `bridge:legacy-sql-readonly`, only when explicitly configured for the
    action and backed by a saved Bridge external system of the same kind.
- The route must reject a source-kind mismatch before adapter creation. There
  is no silent fallback between `data-source:sql-readonly` and
  `bridge:legacy-sql-readonly`.
- The action target is configured server-side. The browser never supplies
  `sheetId`, `objectId`, `keyField`, or `fieldIdMap`.
- Parameter bindings are allowlist-driven. The operator cannot add filters or
  operators.
- v1 supports only equality filters and only one project at a time.
- No raw SQL, no stored procedure, no vendor API call, no PLM write.
- No K3 Save / Submit / Audit / BOM.

## Route contract for implementation

C5 runtime should land in a later implementation slice. The intended routes are
generic enough to reuse for future parameterized actions:

```text
GET  /api/integration/table-actions
POST /api/integration/table-actions/:actionId/dry-run
POST /api/integration/table-actions/:actionId/apply
```

`GET` lists configured actions visible to the current tenant/workspace. It
returns action metadata and parameter schema, not credentials, raw read plans,
or target sheet ids unless the user has the needed admin/debug role.

### Dry-run route

Request:

```json
{
  "parameters": {
    "projectNo": "P2026-001"
  }
}
```

Server steps:

1. `requireAccess(req, "read")`.
2. Load the action config by `actionId` under the current tenant/workspace.
3. Validate parameters against the action schema. Unknown parameters,
   unsupported operators, arrays, objects, or blank required values fail before
   any PLM read.
4. Create the source adapter with the request user principal for this direct
   action read. There is no system/admin fallback.
5. Run C2 expansion with the configured read plan and validated `projectNo`.
6. Read existing stock-preparation rows through a scoped records API bound to
   the configured target.
7. Run C3 conflict planning.
8. Return dry-run status, counts, conflicts, and a server-generated
   dry-run token / revision marker. C5-1 must treat this token as a hard
   precondition for apply, not optional polish.

The dry-run response may support the tenant UI with normal row data, but the
values-free evidence helper must expose only:

- action id;
- project number presence, not value;
- expanded row count;
- C2 status/error categories;
- C3 decision counts;
- manual-confirm count and error codes;
- dry-run timestamp/revision.

### Apply route

Request:

```json
{
  "parameters": {
    "projectNo": "P2026-001"
  },
  "confirm": {
    "dryRunToken": "opaque-server-token",
    "acceptManualConfirmHold": true
  }
}
```

Server steps:

1. `requireAccess(req, "write")`; if the current user has admin, the route may
   pass `permission: "admin"` to C4, otherwise pass `permission: "write"`.
   This value is derived from the authenticated user, never from the client.
2. Load the same action config by `actionId`.
3. Validate parameters again.
4. Recompute C2 expansion and C3 conflict planning server-side from current
   data. The route must not accept a C3 plan or C4 payload from the browser.
5. Require a server-generated dry-run token and compare the recomputed dry-run
   revision with the supplied confirmation token. Missing, stale, or mismatched
   confirmation fails closed. This binds apply to an operator-reviewed dry-run
   and prevents non-UI callers from jumping straight to apply.
6. Inject a records API scoped to the configured stock-preparation target.
   The client cannot point C4 at an arbitrary `sheetId`.
7. Call C4 with the recomputed plan, scoped target, scoped records API, and real
   permission.
8. Return apply counts/status/error codes.

Manual-confirm rows stay held. Clean rows may apply, matching C4's existing
contract: one bad/manual row must not abort clean `add` / `update` / `inactive`
decisions. The response must make `partial`, `held`, and row failure counts
clear.

## Workbench UI contract

The workbench action panel should show:

1. Action selector: "PLM project BOM -> stock preparation".
2. Parameter form generated from the server action schema.
3. Dry-run button.
4. Dry-run summary:
   - expanded rows;
   - `add` / `update` / `skip` / `inactive` / `manual_confirm`;
   - C2 guard/error categories;
   - conflict categories.
5. Apply confirmation section, visible only after a fresh dry-run and only when
   the user has write/admin permission.

Normal users cannot edit:

- SQL;
- source system id;
- PLM object names;
- relation descriptors;
- filter field names;
- target sheet id;
- field id mapping;
- C4 plan payload.

Dry-run and apply must look different. A read-capable user can dry-run; a
write/admin-capable user can apply after confirmation. The UI must not render a
K3 action, Submit/Audit/BOM button, or multi-project/batch mode in v1.

## Records API scoping

C4 is intentionally latent and accepts an injected records API. C5 wiring must
be the first place that scopes that API for real writes.

C5 uses an action-as-authorization model for the target sheet: Data Factory
write/admin permission authorizes running this configured action, and the
server-side action config chooses the stock-preparation sheet. The apply route
does not separately accept or evaluate a user-supplied target sheet. This is
safe only because action config create/edit is admin-only and reviewable.

Implementation locks:

- The route builds the records API from the server's configured target binding,
  not from browser input.
- Query/create/patch calls are restricted to that configured stock-preparation
  sheet/object.
- The route passes the authenticated user's actual Data Factory write/admin
  result into C4.
- A lower-privileged caller cannot use this route to patch another sheet.
- `update` and `inactive` stay find-then-patch; missing rows remain row-level
  failures, not create-on-miss.

## Evidence contract

Tenant UI:

- may show row-level values to authorized workspace users;
- must clearly mark manual-confirm rows and held writes.

Issue/customer evidence:

- must not include PLM row values, component names, materials, quantities,
  target row values, raw dry-run rows, or apply payloads;
- may include values-free counts/status/error codes from C2/C3/C4 summaries.

Template:

```text
actionId: plm.stock-preparation.pull-bom.v1
projectNoPresent: true
dryRun: status=<status>, expandedRows=<n>, actions={add:<n>, update:<n>, skip:<n>, inactive:<n>, manualConfirm:<n>}
apply: status=<status>, written=<n>, counts={created:<n>, updated:<n>, inactive:<n>, held:<n>, failed:<n>}
errorCodes: [<codes only>]
K3: not invoked
externalDbWrite: not invoked
```

## Implementation decomposition

C5 must not land as one large route+UI+apply PR.

| Slice | Scope | Runtime risk |
|---|---|---|
| C5-0 | This design + TODO reconcile | none |
| C5-1 | Backend action contract/routes: list + dry-run + apply recompute, static first action, tests | medium; route exists but UI may still be absent |
| C5-2 | Workbench action UI: parameter form, dry-run summary, apply confirmation | medium; operator-facing |
| C5-3 | Entity-machine validation runbook and values-free smoke evidence | none/runtime validation |

C6 option sync remains after C5. It must not be folded into C5.

## Tests required for C5 implementation

Backend:

- list route returns only action metadata and parameter schema;
- dry-run route rejects unknown/blank/object/array parameters before source
  reads;
- dry-run passes request user principal to the readonly SQL source;
- dry-run uses configured action source and target, not client-supplied source
  or sheet ids;
- if the action is configured for `bridge:legacy-sql-readonly`, dry-run creates
  the Bridge adapter only when the saved external system has the same kind;
- a `data-source`/Bridge source-kind mismatch fails before adapter creation;
- apply recomputes C2/C3 server-side and rejects browser-supplied plan payloads;
- apply passes `permission: "write"` or `"admin"` derived from the authenticated
  user, not a hardcoded value;
- apply injects a target-scoped records API and does not let the client choose
  `sheetId`;
- manual-confirm rows are held while clean rows still apply;
- issue-evidence summary contains no project/component/material values.

Frontend:

- normal user can fill only `projectNo`;
- no raw SQL/source/object/target controls render in the operator form;
- dry-run request body carries only action parameters;
- apply is disabled until a fresh dry-run summary exists;
- apply request body carries only parameters and confirmation marker, not
  `sheetId`, field mappings, C3 plan, or C4 payload;
- read-only user sees dry-run but no enabled apply control;
- no K3 action appears.

Negative controls:

- if the backend accepts a client `sheetId`, the route test must fail;
- if the backend hardcodes C4 permission, the route test must fail;
- if the frontend sends arbitrary plan/source/target data, the request-body
  assertion must fail.

## Boundaries

C5 does not:

- add raw SQL;
- add PLM/external database write;
- call K3;
- add batch/multi-project mode;
- add procurement/warehouse child-table writes;
- sync `config_info` dropdown options;
- package or deploy anything by itself.
