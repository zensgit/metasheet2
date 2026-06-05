# Data Factory #2253 C1b - canonical stock-preparation target provisioning design (2026-06-05)

> **Design-first. No runtime in this slice.** This document responds to the
> C5-3b entity-machine retest: the target-schema preflight works, but the onsite
> stock-preparation table is not a canonical C1 target. C1b defines the safe
> provisioning/binding path before another full C5 smoke. It adds no route, no
> UI, no migration, no PLM read, no MetaSheet row write, and no K3 path.

## Why

C5-3b proved the correct failure mode for a partial explicit `target.fieldIdMap`:
`TARGET_SCHEMA_INCOMPLETE` before any source read. The remaining target blocker
is not a bug in that preflight. It is that the existing onsite stock-preparation
table is a business/manual table and does not carry the canonical C1 PLM/system
fields:

- idempotency and lineage fields such as `idempotencyKey`, `parentSourceId`,
  `path`, and `depth`;
- refresh state fields such as `active`, `lastPlmRefreshRunId`,
  `lastPlmRefreshAt`, `lastPlmRefreshDecision`, and
  `lastPlmConflictSummary`;
- PLM payload fields such as `componentSourceId`, `componentCode`,
  `componentName`, `material`, `sourceVersion`, `rawQuantity`, and
  `totalQuantity`.

Retrofitting that table through a large deployment-env `fieldIdMap` is fragile:
it couples the action to many physical field ids, hits Windows JSON escaping
risks, and makes first-run validation harder. The safer v1 is a canonical target
created or bound from the C1 manifest.

## Product decision

Use a canonical C1 stock-preparation target for the first full C5 smoke.

The legacy `备料主表` may remain untouched or be migrated later through a
separate import/migration slice. Full C5 smoke should not depend on a partial
legacy table map.

## Scope

C1b defines a target readiness/provisioning contract:

1. build a MetaSheet sheet/object structure from
   `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`;
2. create or bind a stock-preparation main table with all C1 fields;
3. keep PLM/system fields and human-preserved fields classified exactly as the
   C1 manifest says;
4. produce a server-side table-action target binding that can omit
   `target.fieldIdMap` because logical field ids match the canonical target;
5. emit values-free readiness evidence.

This slice does not define the runtime implementation yet. Implementation should
be split into smaller follow-ups after this design is reviewed.

## Boundaries

C1b must not:

- read PLM;
- write MetaSheet **rows**;
- run the C2 expander, C3 planner, or C4 writer;
- call K3 Save / Submit / Audit / BOM;
- write to any external database;
- accept raw SQL or user-authored SQL;
- expose source bindings, target sheet ids, field ids, credentials, or business
  row values in issue evidence;
- silently map a legacy business table with missing system fields.

Creating table/field **metadata** is allowed only in the later implementation
slice and only behind admin permission.

## Target readiness modes

| Mode | Meaning | C5 readiness |
|---|---|---|
| `canonical_existing` | Existing target has all canonical logical field ids. | Ready; `target.fieldIdMap` may be empty. |
| `canonical_create` | Admin creates a new target from the C1 manifest. | Ready after creation succeeds. |
| `explicit_complete_map` | Non-canonical target maps every PLM/system field and required human field intentionally. | Allowed, but not the preferred first-smoke path. |
| `explicit_partial_map` | Non-canonical target maps only some fields. | Fail closed as `TARGET_SCHEMA_INCOMPLETE`. |
| `legacy_business_table` | Existing business/manual table with no canonical system fields. | Not ready; do not run full C5 smoke. |

The onsite recommendation selects `canonical_create` or `canonical_existing` for
the first full smoke.

## Required field contract

The canonical target must include every field from
`STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`.

PLM/system fields:

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
- `lastPlmRefreshDecision`
- `lastPlmConflictSummary`

Human-preserved fields:

- `materialType`
- `blankType`
- `stockPreparationStatus`
- `demandDate`
- `leadTimeDays`
- `notes`
- `procurementReply`
- `warehouseConfirmation`

Implementation must use the manifest as the source of truth, not a duplicated
field list. A test must fail if the runtime provisioning list drifts from the
manifest.

## Admin workflow

The implementation should expose one of these admin-only flows:

1. **Create canonical target**: create a new stock-preparation main table from
   the C1 manifest and return a server-side target binding.
2. **Bind existing canonical target**: validate an existing table has all
   logical fields, then return the target binding.

For v1, the browser should not edit PLM/system field ids, source bindings, C3
plans, C4 payloads, or raw action JSON. If an admin UI is added, it should show
readiness state and field presence, not expose private deployment config values.

## Action config output

The preferred canonical target config shape is:

```json
{
  "target": {
    "sheetId": "<server-owned-stock-preparation-sheet-id>",
    "objectId": "plm_stock_preparation_main",
    "keyField": "idempotencyKey",
    "fieldIdMap": {}
  }
}
```

`fieldIdMap` stays empty because canonical logical field ids match the template.
This avoids the large Windows deployment-env JSON map that failed in C5-3a.

If an explicit map is still used, it must remain all-or-nothing for PLM/system
fields and continue to pass C5-3b preflight.

## Source gate stays separate

C1b only solves the target side. Full C5 smoke still also needs a real PLM source
bound as `data-source:sql-readonly`.

If production must use the existing `bridge:legacy-sql-readonly` path, that is a
separate source-design pivot. C1b must not silently widen C5 source kind support.

## Relationship to C6 custom option sync

The user-facing custom option button is supported as C6, not C1b.

C1b creates/binds select fields such as `materialType`, `blankType`, and
`stockPreparationStatus` with `optionSource` metadata. C6 later adds a controlled
sync action that refreshes those field options from `config_info`.

C6 must not be implemented by auto-creating new options during C5 apply. Apply
uses the current target schema/options and fails or manual-confirms when values
do not fit the configured contract.

## Evidence

Allowed issue evidence:

- mode: `canonical_existing`, `canonical_create`, or failed mode;
- field presence counts;
- missing logical field ids;
- ownership counts: PLM/system vs human-preserved;
- option-source keys, not option values;
- target readiness status.

Forbidden issue evidence:

- target sheet id;
- physical field ids if considered private;
- business row values;
- PLM row values;
- datasource ids, credentials, tokens, connection strings;
- action config JSON carrying private bindings.

## Implementation decomposition

| Slice | Scope |
|---|---|
| C1b-0 | This design + TODO reconcile. Docs-only. |
| C1b-1 | Backend manifest-to-target readiness/provisioning helper. Admin-only, metadata only, no rows. |
| C1b-2 | Optional admin UI or runbook to create/bind the canonical target. No PLM read. |
| C1b-3 | Entity-machine target readiness smoke: canonical target present and C5 action can be configured without explicit `fieldIdMap`. |

C5 full smoke resumes only after C1b target readiness and the PLM source gate are
both satisfied.

## Acceptance locks for C1b implementation

- Provisioning uses `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE` as the only field
  contract.
- The helper never writes business rows.
- Admin permission is required for create/bind.
- Canonical target can omit `target.fieldIdMap`.
- Non-canonical explicit maps still go through C5-3b completeness preflight.
- Readiness errors are values-free.
- C1b does not add Bridge source support.
- C1b does not call PLM, K3, or external DB write paths.
- C6 option sync remains a later separate opt-in.
