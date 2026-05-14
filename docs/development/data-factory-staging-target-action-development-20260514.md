# Data Factory staging target action - development notes - 2026-05-14

## Purpose

This slice completes the local multitable side of the Data Factory workflow:

```text
source system -> staging multitable -> dry-run -> target system / target multitable
```

PR #1550 added `metasheet:staging` as a read-only source. PR #1553 added
`metasheet:multitable` as a target-only adapter. This change exposes the target
adapter in the workbench UI so an operator can choose an installed cleansing
table as a write destination without hand-editing external system JSON.

## UI behavior

Each installed staging card now has three actions:

- `打开多维表` opens the business cleansing table.
- `作为 Dry-run 来源` configures the table through `metasheet:staging`.
- `作为写入目标` configures the table through `metasheet:multitable`.

The target action upserts a deterministic external system:

```text
metasheet_target_<projectId>
```

The generated system is target-only:

```json
{
  "kind": "metasheet:multitable",
  "role": "target",
  "capabilities": {
    "write": true,
    "multitableTarget": true,
    "saveOnly": true
  }
}
```

## Target object config

The workbench builds target object config from the existing staging descriptors
and open links returned by `/api/integration/staging/install`.

For stable business tables, the UI supplies key fields:

- `standard_materials`: `["code"]`
- `bom_cleanse`: `["parentCode", "childCode"]`
- any descriptor with `externalId`: `["externalId"]`
- any descriptor with `id`: `["id"]`

When no stable key can be inferred, the target object uses `append` mode. This
keeps logging/exception-style tables usable while avoiding fake upsert keys.

## Boundaries

- No new migration.
- No backend route change.
- No arbitrary user-table permission design.
- No live K3 Submit / Audit behavior change.
- No raw SQL or JavaScript authoring surface.

The action only configures the already-merged `metasheet:multitable` adapter.
Actual writes still pass through the plugin-scoped multitable records API and
the normal pipeline dry-run / Save-only controls.
