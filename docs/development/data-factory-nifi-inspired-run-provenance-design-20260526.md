# Data Factory NiFi-Inspired Run Provenance Design - 2026-05-26

## Summary

This document turns the Data Factory direction into an execution model:
external systems import data into MetaSheet multitables, users cleanse and
review the data in the grid, then Data Factory dry-runs, exports, or pushes the
cleansed rows into a target system. The target system and dataset details are
configuration owned by the user/operator where possible.

The design borrows Apache NiFi's operational discipline, not its full product
shape. We want NiFi-style run tracking, failure routing, retry, back pressure,
parameter contexts, and provenance. We do not want a full visual ETL canvas,
processor graph, cluster scheduler, or arbitrary user scripting surface in this
stage.

Primary outcome:

```text
source system -> source dataset -> raw multitable -> cleansing multitable
  -> dry-run / export / push -> row-level result writeback -> retry / audit
```

## Product decision

Data Factory should be a **multitable-first data preparation layer**, not a
per-ERP plugin page factory.

- Business users edit and review data in multitables.
- Connectors move data in and out of external systems.
- Dataset schemas describe what each system object looks like.
- Mapping rules transform source rows into target rows or payloads.
- Run results make success, failure, retry, external IDs, and errors visible per
  row.

This keeps K3 WISE as the first preset, but the product model also covers CRM,
PLM, ERP, SRM, SQL, HTTP, CSV, and Excel paths.

## Relationship to adjacent Data Factory decisions

This document is the **run/provenance sub-design**. It should be read with these
boundaries:

- `data-factory-hub-direction-20260525.md` / #1838 is the direction and gating
  research note: multitable hub, prior-art survey, and stage-two questions that
  should wait for K3 PoC evidence. This document narrows that direction into
  run, row result, dead-letter, retry, back-pressure, and provenance contracts.
- #1826 is the K3 reference-mapping UI contract. This document does not change
  its reference object composition boundaries.
- #1830 is the K3 Save-only rollback gate. The retry/dead-letter language here
  is Data Factory row retry; it is not a K3 rollback tool and does not replace
  the K3-admin-native rollback procedure.
- #1835 is the S3 read-only runtime unlock decision/design. This document does
  not unlock #1709 read/list runtime or server-pipeline reference composition.

## Apache NiFi ideas to adapt

| NiFi concept | MetaSheet Data Factory adaptation |
|---|---|
| FlowFile content + attributes | Row payload plus row metadata: source, target, run, status, external IDs, errors |
| Processor | Import, normalize, map, validate, preview, push, export, writeback steps |
| Connection queue | Per-run pending rows and retryable rows |
| Back pressure | Pause or rate-limit when target systems fail, slow down, or reject too many rows |
| Relationships | `success`, `failure`, `retry`, `dead_letter`, `skipped` row outcomes |
| Data provenance | Row-level history from source read through cleanse, preview, push, and writeback |
| Parameter Context | Reusable connection/runtime parameters such as base URLs, tenant, timeout, and rate limit |
| Controller Service | Shared connector profiles: K3 login, SQL read-only driver, HTTP client, file import |
| Process Group | A reusable Data Factory template such as `PLM item -> K3 material` |
| Replay | Retry selected failed rows after the user fixes data in the multitable |

External references:

- Apache NiFi documentation: <https://nifi.apache.org/documentation/>
- NiFi User Guide: <https://nifi.apache.org/documentation/nifi-latest/html/user-guide.html>

## What we should not copy from NiFi

- No full drag-and-drop flow canvas in this stage.
- No business-facing `Processor`, `FlowFile`, or `Connection Queue` vocabulary.
- No arbitrary JavaScript transform editor.
- No raw SQL editor for business users.
- No cluster scheduling or distributed flow engine.
- No automatic write expansion to K3 Submit/Audit or multi-record push.

The business-facing terms should remain:

- `数据源` / data source
- `数据集` / dataset
- `清洗表` / cleansing multitable
- `映射规则` / mapping rule
- `预览` / preview
- `推送结果` / push result
- `异常记录` / exception / dead letter

## Core objects

### ConnectorProfile

Reusable connection and runtime parameters.

Required shape:

```json
{
  "id": "k3-wise-main",
  "type": "k3-wise-webapi",
  "displayName": "K3 WISE",
  "environment": "customer-onprem",
  "capabilities": ["read", "preview", "upsert"],
  "parameterContextId": "k3-wise-main-params"
}
```

Notes:

- Secrets are not stored in plain JSON. They stay in secret storage, env files,
  host-side token files, or customer-managed secure channels.
- Connector type controls auth, paging, request signing, retryable error
  parsing, and write semantics.
- `read` and `write` capabilities are explicit. A read-only source connector
  must not silently become a write connector.

### DatasetDefinition

The source or target object exposed by a connector.

Required shape:

```json
{
  "id": "k3.material",
  "connectorProfileId": "k3-wise-main",
  "object": "material",
  "direction": "source-or-target",
  "schema": [
    { "field": "FNumber", "type": "string", "required": true },
    { "field": "FName", "type": "string", "required": true }
  ],
  "identity": ["FNumber"]
}
```

Notes:

- Same system is allowed as both source and target, but datasets must be
  distinct. Example: `k3.material.template` as read source and
  `k3.material.save` as Save-only target.
- SQL datasets must show allowlist/view/middle-table guidance and remain an
  advanced path.
- K3 WISE Material/BOM remain preset datasets, not hard-coded product center.

### CleansingTable

The multitable surface where users cleanse data.

Recommended areas:

- raw area: source snapshots, imported rows, immutable-ish source evidence;
- cleansing area: editable business fields and mapping inputs;
- reference area: user-maintained lookup/reference mapping tables;
- writeback area: run status, external IDs, bill numbers, error messages.

No business user should need to hand-write full JSON payloads. JSON remains for
preview, export, and troubleshooting.

### MappingRule

Maps source/cleansed fields to target fields.

Required capabilities:

- source field selection;
- target field selection;
- whitelisted transforms: `trim`, `upper`, `lower`, `toNumber`, `dictMap`;
- required-field validation;
- min/max validation for numeric fields;
- reference mapping selection;
- dry-run preview.

Forbidden in this stage:

- user JavaScript;
- raw SQL;
- hidden K3 write escalation;
- server-side reference auto-composition unless separately unlocked.

### PipelineRun

A run is one execution attempt over a bounded set of rows.

Required shape:

```json
{
  "runId": "run_20260526_001",
  "pipelineId": "plm-to-k3-material",
  "mode": "dry_run",
  "startedAt": "2026-05-26T00:00:00Z",
  "endedAt": null,
  "operator": "admin",
  "sourceDatasetId": "plm.item",
  "targetDatasetId": "k3.material",
  "mappingVersion": "v1",
  "connectorVersions": {
    "source": "plm-http:v1",
    "target": "k3-wise-webapi:v1"
  },
  "summary": {
    "total": 0,
    "success": 0,
    "failed": 0,
    "skipped": 0,
    "retryable": 0
  }
}
```

### RowResult

Every row gets an outcome. This is the main user-visible record.

Required shape:

```json
{
  "runId": "run_20260526_001",
  "rowId": "standard_materials:row_123",
  "status": "dead_letter",
  "relationship": "failure",
  "sourceDatasetId": "plm.item",
  "targetDatasetId": "k3.material",
  "targetExternalId": null,
  "targetBillNo": null,
  "errorCode": "MISSING_REFERENCE",
  "errorMessage": "Unit reference is unresolved",
  "retryable": true
}
```

Allowed relationships:

- `success`
- `failure`
- `retry`
- `dead_letter`
- `skipped`

### ProvenanceEvent

Append-only history for debugging and audit.

Required event types:

- `source_read`
- `row_imported`
- `row_edited`
- `mapping_applied`
- `validation_failed`
- `dry_run_previewed`
- `target_write_attempted`
- `target_write_succeeded`
- `target_write_failed`
- `row_retried`
- `row_exported`

Event payloads must be redacted. Store presence flags and safe identifiers
where possible. Do not store tokens, passwords, raw connection strings, or
customer secrets.

## Runtime semantics

### Import

- Source connector reads a bounded dataset page or operator-selected file.
- Imported rows land in the raw area.
- Import creates a run and `source_read` / `row_imported` events.

### Cleanse

- Users edit the cleansing multitable.
- Reference/dictionary tables are normal multitables.
- Data Factory does not need to own all business semantics. It needs to make
  unresolved references and invalid fields visible before target write.

### Dry-run

- Dry-run is mandatory before write for risky connectors.
- Dry-run builds target payload previews without calling target write APIs.
- Each row receives `success` or `dead_letter` style preview status.

### Push / export

- Push writes to a target connector only when explicitly enabled.
- Export writes a file artifact such as CSV or Excel.
- K3 WISE remains Save-only by default. Submit/Audit stays locked unless a
  separate owner decision unlocks it.

### Writeback

- Success rows write back external IDs, bill numbers, target status, and
  timestamp.
- Failure rows write back safe error code/message and retryability.
- Failure does not stop the entire run unless the run policy says to pause on
  threshold.

### Retry

- Users fix failed rows in the multitable.
- Retry can target selected rows or retryable failures from a run.
- Retry creates a new run linked to the original run.
- Retry must not re-push previously successful rows unless the operator
  explicitly selects them.

## Back pressure and stop rules

Initial policies:

- max rows per run;
- max rows per batch;
- max consecutive failures before pause;
- target 5xx exponential backoff;
- target auth failure hard stop;
- target validation failure routes row to dead letter;
- K3 Save-only write stays one-record or explicitly bounded until customer
  signoff expands it.

This is the Data Factory version of NiFi back pressure: protect customer
systems and make the pause visible.

## User-authored configuration

Users/operators should be able to provide:

- source connector profile;
- source dataset definition;
- target connector profile;
- target dataset definition;
- staging/cleansing table selection;
- field mapping rules;
- dictionary/reference mapping tables;
- run policy;
- dry-run/export/write mode;
- row retry selection.

Developers should only need to write code for:

- new auth/signature schemes;
- custom paging protocols;
- custom retryable error parsing;
- special target write semantics;
- strongly typed presets such as K3 WISE Material/BOM.

## K3 WISE fit

K3 should become an example of this model:

- ConnectorProfile: K3 WISE WebAPI auth/session handling.
- DatasetDefinition: Material/BOM presets.
- CleansingTable: `standard_materials` / `bom_cleanse`.
- Reference tables: unit/account/unit-group mappings or object references.
- MappingRule: Material/BOM field mappings.
- PipelineRun: dry-run and Save-only runs.
- RowResult: K3 item ID, number echo, bill number, error code.
- ProvenanceEvent: source import, preview, Save attempt, readback check.

Current locks remain:

- no BOM expansion from this design;
- no Submit/Audit;
- no multi-record K3 expansion;
- no server-pipeline reference auto-composition unless separately unlocked;
- read/list runtime remains governed by the S3 / #1709 decision path.

## Phased implementation plan

Only **DF-N0** is covered by this PR. Later phases are design targets, not
authorization to start implementation. Each later phase needs its own PR and
gate review, especially if it touches integration runtime, migrations,
connector behavior, retry workers, or package delivery.

### DF-N0 - Contract only

- Add this design.
- Add verification notes.
- No runtime change.

### DF-N1 - Run result UI on existing surfaces

- Surface run summary, row status, retryability, and dead-letter links in Data
  Factory.
- Prefer existing `integration_run_log` and `integration_exceptions` behavior
  where possible.
- No new external connector behavior.
- Expected lock profile: front-end / read-existing-state first. Any API or
  persistence change must be split into its own gated PR.

### DF-N2 - Provenance event contract

- Define the append-only event shape.
- Decide whether the first implementation uses existing logs, JSONB metadata,
  or a new migration.
- Keep payload redaction mandatory.
- Separate gated opt-in required. A new event table, migration, or write path is
  not authorized by this document.

### DF-N3 - Retry and back pressure

- Add bounded retry of selected failed rows.
- Add stop rules for auth failure, high failure rate, and target 5xx.
- Add run policy defaults per connector.
- Separate gated opt-in required. This phase can affect pipeline runtime
  semantics and must not be inferred from this docs-only PR.

### DF-N4 - Connector template catalog

- Standardize source/target dataset templates.
- Make K3 WISE a preset template, not a special product lane.
- Add HTTP JSON, SQL read-only, CSV/Excel import/export templates.
- Separate gated opt-in required. This is the broadest platform-catalog phase
  and should follow the K3 PoC evidence and stage-two owner decision.

## Verification strategy

For any future implementation PR:

- unit-test row relationship routing;
- unit-test redaction;
- unit-test retry selection does not include prior successes;
- unit-test back pressure stop rules;
- front-end test Data Factory run status and dead-letter links;
- package-verify any Windows on-prem operator docs and scripts;
- perform one K3 Save-only path only under the existing K3 GATE rules.

## Non-goals

- Full NiFi-compatible processor engine.
- Visual flow canvas.
- Arbitrary user code execution.
- Raw SQL editor for business users.
- Unbounded target writes.
- K3 Submit/Audit.
- BOM expansion.
- Multi-record K3 push without a separate owner decision.
