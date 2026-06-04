# Data Factory - PLM project BOM to stock-preparation tables - C0 design (2026-06-04)

> **Design-first. No runtime in this slice.** This document locks the C0
> contract for issue #2253: an operator enters one project number, Data Factory
> reads a PLM BOM through an existing `data-source:sql-readonly` source, expands
> it recursively, previews the stock-preparation changes, and later applies
> those changes to MetaSheet tables only. C0 adds no route, no helper, no UI, no
> migration, and no K3 write path.

## Why

The customer has a legacy production stock-preparation flow driven by a PLM
project number. The product goal is not a generic SQL editor. It is a named
business action:

1. Read one project BOM by project number.
2. Expand the recursive BOM into material demand rows.
3. Compare those rows with an existing stock-preparation main table.
4. Preserve human-entered planning fields while refreshing PLM/system fields.
5. Apply the accepted plan to MetaSheet tables.

This sits on top of the already shipped read-only SQL bridge. The bridge proves
that Data Factory can read an owner-scoped SQL data source without copying
credentials. This C0 defines the business action that consumes that bridge.

## Relationship to the SQL bridge smoke

The datasource bridge validation stream (#2250 / #2254 and follow-up packages)
can continue in parallel. That stream proves the generic read-only SQL source is
deployable and operator-usable. This #2253 track is downstream business logic:
it consumes that source through a parameterized action and writes only MetaSheet
stock-preparation rows after dry-run/planner acceptance. A bridge smoke failure
blocks #2253 runtime, but it does not change this C0 business contract.

## Scope boundary

This track adds a **parameterized PLM BOM pull action**:

```
projectNo -> readonly PLM SQL read -> recursive BOM expansion -> dry-run plan
          -> optional apply to MetaSheet stock-preparation main table
```

It does **NOT**:

- expose raw SQL or user-authored SQL;
- write to the PLM database or any external database;
- call K3 Save / Submit / Audit / BOM;
- unlock K3 multi-record or production write;
- generate procurement and warehouse child tables in v1;
- merge the PLM adapter/API track into this v1;
- start background job runtime in C0.

## Locked v1 answers from #2253

| Topic | v1 decision |
|---|---|
| Source | `data-source:sql-readonly` / readonly SQL source only. PLM adapter/API is a later extension. |
| Query shape | Parameterized `projectNo`; no raw SQL and no user-authored SQL. |
| Match | Single project number, exact match on `FileCode`; no fuzzy, prefix, or batch match in v1. |
| No hit | Dry-run returns `0 rows` plus a clear not-found summary. It does not create a project row. |
| Identity | `projectNo + componentSourceId(OBJ_ID) + parentSourceId/path`. Same component under different parents remains a distinct row. |
| Expansion | Recursive quantity multiplication; preserve raw quantity, total quantity, depth, and path. |
| Guards | `maxDepth`, `maxRows`, and cycle guard fail closed. Oversized work must not block a sync request indefinitely. |
| Target | v1 writes the stock-preparation main table only. Procurement/warehouse are views or later slices. |
| Conflict default | Add missing rows, refresh PLM/system fields, preserve human fields, skip/mark duplicates, mark PLM-missing rows inactive, never delete by default. |
| Conflict config | Default conflict strategy is configurable at project/table/pipeline scope; a run can override it later. |
| Permissions | Dry-run uses Data Factory read/source-read; apply/write uses Data Factory write/admin. |
| Boundary | MetaSheet write only. No K3 Save / Submit / Audit / BOM. |
| Scale | Design for dozens to thousands of rows. Exceeding guard thresholds fails closed or moves to background/paged execution in a later slice. |

## Source contract

The action binds to an existing Integration external system of kind
`data-source:sql-readonly`.

Required source binding:

```json
{
  "kind": "data-source:sql-readonly",
  "role": "source",
  "config": {
    "dataSourceId": "ds_...",
    "object": "plm_bom_or_view"
  }
}
```

The action must not receive credentials. The Integration row carries only the
`dataSourceId` reference. Ownership and visibility stay enforced by the bridge:
direct test/schema reads use the request user, and pipeline runs use
`pipeline.createdBy`.

The PLM read is a named, parameterized read plan. The exact PLM table/view and
relationship columns are configured in C1/C2, but the action must only bind
known fields. A free-form SQL textarea is explicitly out of scope.

### Feasibility gate for C1/C2

Because raw SQL is forbidden, recursive BOM expansion must be implemented
app-side over flat, parameterized reads from the readonly SQL source. C1/C2 must
confirm this is feasible before runtime starts. If the customer PLM exposes the
needed BOM only through a recursive CTE, stored procedure, or vendor API call,
v1 must pivot to either a customer-provided flat BOM view or the deferred PLM
adapter/API track; it must not add a raw-SQL escape hatch.

## Match and no-hit contract

Input:

```json
{ "projectNo": "P2026-001" }
```

v1 matching:

- trims the operator input;
- rejects blank input;
- filters PLM rows by exact `FileCode = projectNo`;
- returns a not-found dry-run summary when no BOM root is found;
- does not create a stock-preparation project/header row on not-found.

No-hit evidence shape:

```json
{
  "projectNoPresent": true,
  "matchField": "FileCode",
  "status": "not_found",
  "rowsExpanded": 0,
  "actions": {
    "add": 0,
    "update": 0,
    "skip": 0,
    "inactive": 0,
    "manualConfirm": 0
  }
}
```

## Recursive BOM expansion contract

The expansion output is a normalized logical row, not yet a MetaSheet write:

| Field | Purpose |
|---|---|
| `projectNo` | Operator input / PLM `FileCode` match. |
| `componentSourceId` | Stable PLM source id, expected `OBJ_ID` when available. |
| `parentSourceId` | Parent PLM source id, null only for root/top-level rows. |
| `path` | Stable path token chain for idempotency and traceability. |
| `depth` | Recursive depth from the project/root BOM. |
| `componentCode` | PLM component code/drawing number. |
| `componentName` | PLM component name. |
| `material` | PLM material field when available. |
| `sourceVersion` | PLM system version, for example `SysVer` when available. |
| `rawQuantity` | Quantity at the current BOM edge. |
| `totalQuantity` | Multiplied quantity across the path. |
| `active` | Planned active state; PLM-missing old rows become inactive, not deleted. |

Rules:

- Quantity multiplication is deterministic and numeric. Non-numeric required
  quantity fails the row, not the whole batch, unless it prevents path identity.
- Path/parent are part of the identity. The same component under two parents is
  two stock-preparation rows.
- Cycle guard fails closed. The expander must never loop indefinitely.
- `maxDepth` and `maxRows` are hard guards. Crossing a guard returns a dry-run
  failure with counts and the guard that fired. It must not silently truncate.
- The action records enough lineage to support later DF-N provenance display.

## Idempotency key

The durable v1 key is:

```text
projectNo + componentSourceId + parentSourceId/path
```

Implementation detail may serialize this as a stable string, for example:

```text
projectNo=<projectNo>|component=<OBJ_ID>|parent=<parentId>|path=<path>
```

The key must not use component code alone. Component code can repeat, change, or
appear under several parents.

## Target table model

v1 writes one MetaSheet stock-preparation main table. C1 defines the exact
manifest, but the logical columns are:

### PLM/system-owned fields

- `projectNo`
- `idempotencyKey`
- `componentSourceId`
- `parentSourceId`
- `path`
- `depth`
- `componentCode`
- `componentName`
- `material`
- `sourceVersion`
- `rawQuantity`
- `totalQuantity`
- `active`
- `lastPlmRefreshRunId`
- `lastPlmRefreshAt`

### Human-owned fields

These are preserved by default during refresh:

- `materialType`
- `blankType`
- `stockPreparationStatus`
- `demandDate`
- `leadTimeDays`
- `notes`
- `procurementReply`
- `warehouseConfirmation`

C1 must pin the exact whitelist. Any field not explicitly classified must fail
closed during apply planning instead of being overwritten by accident.

### Views instead of child tables in v1

Procurement and warehouse surfaces are views or filtered layouts over the main
table in v1. Separate procurement/warehouse child-table generation is deferred
to a later explicit slice.

## Conflict planner contract

Dry-run computes decisions without writing:

| Decision | Meaning |
|---|---|
| `add` | PLM row exists and no matching stock-preparation row exists. |
| `update` | Matching row exists; PLM/system fields will refresh; human fields preserve. |
| `skip` | Duplicate or unchanged row that needs no write under the default strategy. |
| `inactive` | Existing row no longer appears in PLM; mark inactive, do not delete. |
| `manual_confirm` | A critical conflict requires human review before apply. |

Default conflict strategy:

- add missing rows;
- refresh only PLM/system-owned fields;
- preserve human-owned fields;
- skip or mark duplicate BOM rows instead of picking one silently;
- mark PLM-missing existing rows inactive;
- never delete by default;
- record `runId`, `decision`, and `conflictSummary` for every applied row.

Manual-confirm triggers are finalized in C3, but C0 reserves these classes:

- same idempotency key but incompatible path/parent lineage;
- component source id collision with different component identity;
- non-numeric or negative quantity where quantity is required;
- duplicate PLM rows where the default strategy cannot choose safely;
- apply would overwrite a human-owned field.

## Permissions

| Operation | Permission posture |
|---|---|
| Dry-run | Data Factory read/source-read; source ownership enforced by the readonly SQL bridge. |
| Apply | Data Factory write/admin; writes MetaSheet tables only. |
| Evidence export | Read permission; values-free issue/customer evidence only. |

There is no K3 permission path in this track. K3 Save / Submit / Audit / BOM
remain unrelated scoped gates.

## Evidence and redaction

The live UI may show business values to authorized operators because the
operator is working inside the tenant workspace. Issue/customer evidence must
remain values-free:

Allowed evidence:

- project number presence, not the project number;
- match field name (`FileCode`);
- object/table names when not sensitive;
- expanded row count;
- max depth;
- guard status;
- action counts (`add/update/skip/inactive/manualConfirm`);
- conflict types;
- field names and ownership class (`plm_system` / `human_preserved`);
- run id.

Forbidden evidence:

- connection secrets or connection strings;
- raw SQL;
- raw PLM rows;
- raw stock-preparation row values;
- full payload JSON if it carries business values.

## Runtime decomposition

Each implementation slice is a separate explicit opt-in.

| Slice | Scope |
|---|---|
| C0 | Design + TODO docs only. No runtime. |
| C1 | Stock-preparation table template / field model manifest. Schema-only; no PLM read, no write. |
| C2 | `projectNo -> PLM BOM` dry-run expansion helper. Recursive read + normalized rows; no MetaSheet write. |
| C3 | Conflict planner. Computes `add/update/skip/inactive/manual_confirm`; preserves human fields; no write. |
| C4 | Apply writer. Writes only the MetaSheet stock-preparation main table; records run id, decision, and conflict summary. |
| C5 | Workbench UI action. Project number input, dry-run summary, apply confirmation; no K3. |
| C6 | `config_info` option sync. Keeps select/dropdown options aligned for configured stock-preparation fields. |

Deferred:

- PLM adapter/API source;
- fuzzy/prefix/batch project matching;
- procurement and warehouse child-table generation;
- background/paged execution for very large BOMs;
- C3 watermark/incremental SQL bridge implementation;
- external database writes;
- K3 Save / Submit / Audit / BOM.

## Acceptance locks for future implementation

- The PLM read uses `data-source:sql-readonly`; no raw SQL string is accepted.
- `projectNo` is required and matches `FileCode` exactly in v1.
- PLM no-hit returns dry-run `0 rows` and does not write a project/header row.
- Idempotency includes project number, component source id, and parent/path.
- Same component under different parents remains separate.
- `maxDepth`, `maxRows`, and cycle guards fail closed with explicit evidence.
- Dry-run reports add/update/skip/inactive/manual-confirm counts.
- Human-owned fields are preserved by whitelist and never overwritten silently.
- Missing PLM rows become inactive; apply does not delete by default.
- Apply writes MetaSheet only; no external DB write and no K3 call.
- Permissions separate dry-run read/source-read from apply write/admin.
- Issue/customer evidence is values-free.
- Each C1-C6 slice remains a separate PR-level opt-in.
