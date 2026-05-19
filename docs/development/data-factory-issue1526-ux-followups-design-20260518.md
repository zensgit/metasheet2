# Data Factory issue #1526 UX follow-ups design - 2026-05-18

## Scope

This slice addresses the remaining operator-facing gaps found during the bridge smoke after the `dd1b87eb` package:

- Data Factory Workbench allowed an accidental `bom_cleanse -> material` pairing. The dry-run could succeed with zero records, which looked like a product pass while not testing the material path.
- K3 WISE preset pipeline creation still looked like a dead end when a PLM source system ID was absent, even when the operator already had MetaSheet staging tables available.
- SQL Server connection testing rendered the full diagnostic JSON inline. The known `SQLSERVER_EXECUTOR_MISSING` condition should be a concise operator message first, with raw diagnostics collapsed for implementers.

The change is intentionally frontend/UX/docs only. It does not touch `plugins/plugin-integration-core`, migrations, backend routes, SQL executor wiring, K3 WebAPI read/list runtime, relationship resolver runtime, or real K3 writes.

## Workbench source/target pairing guard

The Workbench now has a small K3 staging pairing table:

| Target template | Recommended staging source |
| --- | --- |
| `material` | `standard_materials` |
| `bom` | `bom_cleanse` |

When the selected source is a MetaSheet staging source and the selected target is a known K3 template, the page compares the actual source object with the recommended staging object.

If they differ, the page:

- shows a strong warning explaining that the dry-run can succeed with zero processable rows;
- exposes a one-click action to switch to the recommended staging source;
- adds a readiness item named `确认来源与目标匹配`;
- blocks save/dry-run by making the readiness item false;
- throws the same message from `buildPipelinePayload()` as a last guard.

The staging install auto-source selection also now prefers the target-specific staging object before falling back to the generic `standard_materials` default. This keeps the material smoke path on `standard_materials -> material` while still allowing a BOM target to prefer `bom_cleanse`.

## K3 preset PLM-first wording

The K3 preset remains a PLM-first creation page for material/BOM pipelines. It still requires `sourceSystemId` when the operator asks this page to create those preset pipelines.

The page and service validation now explain the alternative path:

- if a PLM source system exists, paste/select its source system ID and create preset pipelines here;
- if the operator already has MetaSheet staging tables and wants a staging-first flow, use `/integrations/workbench`, select the MetaSheet staging source, and create the pipeline there.

This preserves the current API contract while removing the "I have staging data but this page blocks me" ambiguity.

## SQL test diagnostics

Connection tests now write:

- a short `connection-test-summary` for normal operators;
- the full raw JSON under a collapsed `details` block for diagnostics.

For `SQLSERVER_EXECUTOR_MISSING` and equivalent query-executor wording, the summary is normalized to:

`SQLSERVER_EXECUTOR_MISSING: current deployment has no SQL executor injected, so the SQL read channel cannot act as a data source yet.`

This is a UI presentation change only. It does not hide the SQL source as fixed, does not inject an executor, and does not change backend test results.

## Non-goals

- No SQL Server executor implementation.
- No K3 WebAPI read/list runtime.
- No relationship resolver runtime.
- No new migration or table.
- No real K3 Save / Submit / Audit path.
- No removal of raw diagnostics for implementers; diagnostics are collapsed, not discarded.
