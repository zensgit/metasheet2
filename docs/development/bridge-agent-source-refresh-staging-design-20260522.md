# Bridge Agent Source Refresh Staging Design

Date: 2026-05-22

## Purpose

BA-M3 proves the first real Data Factory refresh path after the readonly Bridge
Agent work:

```text
customer SQL readonly views -> Bridge Agent -> MetaSheet pipeline runner -> plm_raw_items
```

The slice is deliberately narrow. It does not add a new adapter, does not add a
database migration, and does not write to K3 WISE. It only extends the existing
postdeploy smoke so an entity-machine operator can prove that fresh readonly
Bridge rows can land in MetaSheet staging multitables.

## Inputs

The smoke assumes BA-M2 is already deployed and green:

- a `bridge:legacy-sql-readonly` source system exists;
- the source can list and sample `material`, `bom`, and `bom_child`;
- the Bridge Agent is running on the MetaSheet on-prem host;
- the MetaSheet admin token is supplied by file, not pasted into commands.

The smoke can also install its own staging target with
`--bridge-refresh-install-staging`. That mode calls
`/api/integration/staging/install`, reads the returned `plm_raw_items`
descriptor, and upserts a `metasheet:multitable` target that exposes only that
raw staging object.

## Pipeline Shape

The smoke creates three active pipelines:

| Pipeline id | Source object | Target object |
| --- | --- | --- |
| `bridge_refresh_material_to_plm_raw_items` | `material` | `plm_raw_items` |
| `bridge_refresh_bom_to_plm_raw_items` | `bom` | `plm_raw_items` |
| `bridge_refresh_bom_child_to_plm_raw_items` | `bom_child` | `plm_raw_items` |

Each pipeline is capped:

- `batchSize=3`
- `maxPages=1`
- `options.bridgeRefresh.maxRows=3`

That makes the smoke safe for entity-machine retesting. It proves the wiring
without trying to import the customer's full legacy SQL dataset.

## Field Mapping

The target `plm_raw_items` rows use a common staging identity:

- `sourceSystemId`
- `objectType`
- `sourceId`

Object-specific source fields are mapped into the raw staging columns used by
the current Data Factory/K3 material flow:

| Source object | Source field | Target field |
| --- | --- | --- |
| `material` | `ID` | `sourceId` |
| `material` | `IdentityNo` | `code` |
| `material` | `IdentityName` | `name` |
| `bom` | `ID` | `sourceId` |
| `bom` | `bom_id` | `code` |
| `bom` | `part_id` | `name` |
| `bom_child` | `ID` | `sourceId` |
| `bom_child` | `part_id` | `code` |
| `bom_child` | `brand` | `name` |

The mapping is intentionally not a business-cleanse model. It only ensures the
raw staging table receives stable source identity and a small visible label for
operator review. Real cleansing still happens in MetaSheet multitables after
the refresh.

## Run Contract

The smoke saves each pipeline, then calls:

```text
POST /api/integration/pipelines/:id/run
```

with:

```json
{
  "tenantId": "<tenant>",
  "workspaceId": null,
  "mode": "full"
}
```

A run passes only when the response summary proves all capped rows completed:

- `rowsRead` is greater than zero and at most three;
- `rowsCleaned == rowsRead`;
- `rowsWritten == rowsCleaned`;
- `rowsFailed == 0`;
- run status is `succeeded`.

If the runner reads three rows but writes two, the smoke fails. That keeps the
entity-machine signoff honest: partial refresh is not treated as a green bridge.

## Evidence Hygiene

The evidence records only:

- check ids;
- pass/fail/skipped state;
- source and target system ids;
- pipeline ids;
- object names;
- row counts.

It does not record row values, SQL host names, SQL database names, SQL user
names, Bridge shared secrets, K3 tokens, K3 credentials, or connection strings.

## Package Contract

`multitable-onprem-package-verify.sh` now gates the BA-M3 pieces:

- postdeploy smoke CLI flags:
  - `--bridge-source-refresh-smoke`
  - `--bridge-refresh-install-staging`
- postdeploy smoke check markers:
  - `bridge-refresh-target-install`
  - `bridge-refresh-material-run`
- runbook documentation for the entity-machine command;
- this design document and its verification companion.

The intent is boring but important: if the official Windows on-prem package is
rebuilt without this smoke path, package verify fails before deployment.

## Out Of Scope

- K3 Save, Submit, or Audit.
- Relationship expansion beyond the three BA-M2 source objects.
- Incremental watermarks or production scheduling.
- Full customer dataset import.
- SQL write operations, raw SQL entry points, stored procedures, or DDL.
- Frontend UI changes.
- New database migrations.

## Next Step After BA-M3

If the entity-machine smoke passes, the next product slice can turn this into a
user-facing "refresh source into staging" action. That should remain a separate
PR because it touches Data Factory UX and must decide how much scheduling and
operator confirmation belongs in the product surface.
