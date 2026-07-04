# Data Factory PLM stock-preparation standard solution S0 design lock (2026-07-04)

## Status

S0 is a design-lock slice for #3551.

This document defines the standard MetaSheet business solution shape for:

```text
PLM project BOM -> MetaSheet stock-preparation main table
```

It adds no runtime, route, UI, migration, package, worker, source read, target
write, K3 call, external write, or production/batch rollout. It does not
authorize Apply. It leaves #3551 open.

## Why this lock exists

The already-built stock-preparation line has the hard parts: canonical target
manifest, target readiness, project-number dry-run, conflict planning,
snapshot/diff posture, duplicate/manual-confirm handling, large-BOM
checkpointing, and field-option sync generalization.

What is still missing as a product surface is a single standard business
solution that an implementation team can recognize and deploy without exposing
custom wiring details. S0 therefore locks the information architecture and
boundary for a reusable solution, while preserving the proven gates underneath.

## Existing primitives this solution reuses

S0 must compose existing stock-preparation primitives instead of inventing a
parallel path:

- target template / object: `plm.stock-preparation.main.v1`;
- action preset: `plm.stock-preparation.pull-bom.v1`;
- target readiness / create-or-bind evidence surface;
- `projectNo` parameterized dry-run over the approved PLM readonly source;
- conflict planner decisions: `add`, `update`, `skip`, `inactive`,
  `manual_confirm`;
- fresh dry-run token + revision gate before Apply;
- duplicate-expanded-key held/manual-confirm posture;
- missing-child BOM snapshot/diff held posture;
- large-BOM authoritative artifact + checkpoint apply posture;
- field-option sync as a generic capability with stock-preparation as a preset.

Implementation slices may rename UI labels, add guided screens, and improve
operator workflow. They must not fork the underlying write, source, or evidence
semantics.

## Entity-machine baseline addendum (2026-07-04)

After S0 merged, the current on-prem business setup produced values-free
baseline evidence for #3551:

```text
stockPreparationTableVisible=true
stockPreparationRowsObserved=9
stockPreparationFieldCoverage=projectNo,parent/child component fields,totalQuantity,materialId,rawMaterialTypeId,blankTypeId,stockPrepStatusId,legacySystemId,plmObjectId
bridgeSource=BA-M2 PLM Bridge Agent 74c5e998d
bridgeSourceConnection=PASS
bridgeReadableObjects=material,bom,bom_child
directPlmSqlSource=SQLSERVER_TEST_FAILED
k3WebApiTarget=PASS
```

Existing Bridge refresh pipelines also proved the PLM Bridge -> Data Factory
dry-run lane is alive for small samples:

```text
bridge_refresh_material_to_plm_raw_items: status=succeeded rowsRead=3 rowsCleaned=3 rowsWritten=0 rowsFailed=0
bridge_refresh_bom_to_plm_raw_items: status=succeeded rowsRead=3 rowsCleaned=3 rowsWritten=0 rowsFailed=0
bridge_refresh_bom_child_to_plm_raw_items: status=succeeded rowsRead=3 rowsCleaned=3 rowsWritten=0 rowsFailed=0
```

However, those existing refresh pipelines do not yet expose the business action
shape:

```text
existingBridgeRefreshPipelinesHaveSourceOptions=false
existingBridgeRefreshPipelinesHaveFilters=false
existingBridgeRefreshPipelinesHaveParameters=false
```

So S1 remains create/bind/readiness only. S2 must add the parameterized action
surface for `projectNo` rather than treating the existing refresh pipelines as
the final business action. S2 acceptance must include:

```text
projectNoInputSupported=true
projectNoSelectFromPlmSupported=true_or_followup
browserSubmitsOnlyAllowlistedParams=true
sourceOptionsOrActionParamsContainProjectNo=true
rawSqlOrSourcePayloadFromBrowser=false
plmBridgeDryRunWithProjectNoReturnsCounts=true
applyRequiresFreshDryRunToken=true
k3SaveSubmitAuditBomWrite=false
```

## Scope boundary

In scope:

- create a standard stock-preparation table or bind an existing one;
- show target readiness and repairable missing system-field evidence;
- select an approved PLM readonly source;
- accept a single `projectNo` runtime parameter through an allowlisted UI;
- dry-run PLM BOM expansion and review counts/conflicts/diff evidence;
- apply accepted non-held rows to the MetaSheet stock-preparation main table
  only, using the existing apply gate;
- preserve human-owned fields across refresh;
- present procurement, warehouse, approval, and notification as later views or
  workflow extensions over the stock-preparation table.

Out of scope:

- browser-supplied SQL, source ids, target sheet ids, field id maps, plans, caps,
  payloads, or raw filters;
- writing PLM, K3, external databases, production targets, or batch targets;
- K3 Save / Submit / Audit / BOM write;
- procurement/warehouse child-table generation in S0;
- workflow automation, notifications, approval routing, or third-party process
  writes in S0;
- automatic duplicate resolution beyond already-reviewed policy gates;
- recursive/background large-BOM production rollout beyond the existing gated
  checkpoint model.

## Product surface

The standard solution should expose two top-level entrances.

### 1. Create standard stock-preparation table

This path creates a canonical stock-preparation main table from
`plm.stock-preparation.main.v1`.

The UI must make these facts visible before the operator proceeds:

- selected tenant/workspace context;
- selected PLM readonly source;
- target object/preset identity;
- system-owned fields that PLM refreshes;
- human-owned fields that refresh preserves;
- which later extensions are not part of this step.

Create must be metadata-only until the operator explicitly starts a dry-run.
Creating the table must not read PLM or write business rows.

### 2. Bind existing stock-preparation table

This path runs target readiness against an existing table and reports:

- ready/not-ready status;
- missing logical system fields;
- whether the field-map mode is canonical;
- option-source readiness;
- repair actions that are safe to offer.

Readiness evidence must remain values-free. Private admin binding material, such
as physical sheet ids or field ids, must not be copied into issue/customer
evidence.

Existing tables with incomplete schema must fail closed until repaired. The
solution must not silently infer unknown field ownership.

## Field ownership lock

System-owned fields are refreshed from PLM and apply metadata. At minimum the
solution treats these logical fields as PLM/system-owned:

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

Human-owned fields are preserved by default. The v1 user-facing set includes:

- `materialType`
- `blankType`
- `stockPreparationStatus`
- `demandDate`
- `leadTimeDays`
- `notes`
- `procurementReply`
- `warehouseConfirmation`

Any unclassified field must fail closed during planning or readiness. A refresh
must not overwrite a field merely because it exists on the target table.

## Runtime input lock

The runtime action accepts only allowlisted business parameters.

For v1, the required runtime parameter is:

```json
{ "projectNo": "<operator-entered-or-selected-project-number>" }
```

The UI may support:

- manual input;
- search/select from an approved PLM readonly list in a later slice;
- saved per-table/action defaults for review preferences.

The browser must never supply:

- source system id or source object;
- target sheet id or field id map;
- raw SQL, filter expression, or adapter body;
- max rows/depth/caps;
- plan payload or apply payload;
- credentials, tokens, or connection strings.

All source, target, cap, and field-map material is server-side configuration
bound to the approved preset/action.

## Dry-run, review, and apply lock

Dry-run is mandatory. Apply is never the first step.

Dry-run must show operator-usable review data inside the tenant UI, but public
evidence must stay values-free. Apply requires:

- a fresh server-issued dry-run token;
- the server-recomputed action/config/source/target revision;
- authenticated write/admin permission;
- no unresolved held/manual-confirm rows being written;
- the existing route/in-function sandbox or production gate relevant to the
  write target.

Apply writes only MetaSheet stock-preparation rows. It must not write PLM, K3,
an external database, a production canonical target, or a batch target unless a
separate owner gate explicitly authorizes that different path.

## Conflict and lifecycle defaults

Default behavior:

- `add`: create missing stock-preparation rows;
- `update`: refresh only PLM/system-owned fields;
- `skip`: leave unchanged rows untouched;
- `inactive`: mark rows missing from latest PLM inactive, never delete by
  default;
- `manual_confirm`: hold, write nothing.

The standard solution may expose review controls for duplicate and held groups,
but those controls are evidence/review surfaces unless a separately implemented
policy slice already authorizes the effect. A UI selector must not silently turn
held rows into writes.

`missing_child_bom` is source-incomplete, not a normal leaf. It stays held until
the source proves the component is a real leaf or a later explicitly gated
policy handles the branch.

Large BOMs must use completed authoritative artifacts and checkpointed apply
routes. Bounded previews are not authoritative plans.

## Synchronization strategy lock

The standard solution must not hard-code one synchronization behavior for all
customers. A later policy slice may expose one of these modes:

```text
mode=manual
behavior=user enters/selects projectNo -> dry-run -> explicit Apply

mode=auto_discover_manual_confirm
behavior=system periodically detects new PLM orders/BOM/BOM changes -> creates review task -> user confirms -> Apply to stock-preparation table
recommendedDefault=true

mode=auto_insert_confirm_changes
behavior=new project/new BOM rows may be inserted automatically if customer enables it; existing-row changes, duplicates, hierarchy changes, missing child BOM, and inactive/deleted source rows still require review/confirmation
```

All modes must keep these guardrails:

```text
humanFieldsPreserved=true
neverAutoOverwriteHumanFields=true
missingChildBom=held
sourceDeletedRows=markInactive_notDelete
duplicates=review_or_customerDefaultPolicy
auditLogRequired=true
sourceSnapshotRequired=true
dryRunReviewRequiredForChanges=true
k3SaveSubmitAuditBomWrite=false
```

S0 does not authorize background polling, automatic inserts, automatic Apply, or
production/batch rollout. Those behaviors belong to later S3/S4/S5 policy and
operator-run slices after the parameterized `projectNo` action exists.

## Snapshot and diff lock

Every PLM pull in this standard solution should be tied to a source snapshot
posture:

```text
latest PLM pull -> private source snapshot -> diff against last applied snapshot
```

The UI should present values-free categories such as:

- added rows;
- removed from latest snapshot;
- quantity changed;
- hierarchy changed;
- source fields changed/completed;
- missing child BOM;
- manual fields protected;
- held conflicts.

Private snapshot data may contain business values needed for tenant runtime
diffing. Public evidence must not contain project numbers, material numbers,
component names, parent/path values, raw PLM rows, target row values, raw SQL,
credentials, tokens, or connection strings.

## Field-option sync posture

Field-option sync is a generic Data Factory capability. The user-facing primary
action is `Sync options` / `Refresh field options`; stock-preparation option
sync is one preset, not the page identity.

The standard solution may surface an option-sync step for stock-preparation
fields, but it must preserve the FOS locks:

- no PLM/K3/external write;
- no browser-supplied source/target/payload;
- values-free evidence;
- preset/action binding allowlists.

## Procurement, warehouse, approval, and notification posture

These are business workflow extensions over the stock-preparation table, not
part of PLM Apply.

S0 recommends:

- views or filtered layouts first for procurement and warehouse status;
- workflow/automation slices later for tasks, reminders, approval, export, and
  role handoff;
- separate integration presets for any third-party process system.

No procurement/warehouse/approval/notification slice may ride on a PLM apply
slice unless its own design lock and stop rules are explicit.

## K3 boundary

This standard solution covers only PLM -> MetaSheet stock-preparation.

It must not trigger:

- K3 Save;
- K3 Submit;
- K3 Audit;
- K3 BOM write;
- K3 production/batch write.

K3 read-only surfaces, K3 resolver/composition, and K3 write paths remain
separate Data Factory / Integration gates.

## Evidence lock

Allowed public evidence:

- preset/action ids;
- source kind and target object logical ids;
- project number present/absent, not the project number;
- readiness status and logical missing-field ids;
- row counts, node counts, edge counts;
- max-depth/max-row guard status;
- action decision counts;
- held reason tokens and conflict type counts;
- snapshot/diff category counts;
- option-sync field/source keys and option counts;
- status/error codes.

Forbidden public evidence:

- project numbers;
- material/component codes, names, ids, paths, or parent ids;
- raw PLM rows, raw target rows, raw K3 payloads;
- physical sheet ids or field ids;
- credentials, tokens, connection strings, hosts, tenant ids, or system ids when
  they are not deliberately approved evidence;
- raw SQL, JavaScript, handler bodies, adapter request bodies, or stack traces
  carrying values.

## S0 -> S6 delivery ladder

Each rung is a separate opt-in. S0 does not authorize later rungs.

| Slice | Scope | Boundary |
|---|---|---|
| S0 | Standard solution design-lock + UI information architecture. | Docs only. No runtime/UI/migration/write. |
| S1 | Create/bind/readiness wizard for the stock-preparation table. | Metadata only until dry-run. No PLM read or business-row write. |
| S2 | Project-number action UI. Manual input first; search/select later if backed by an approved readonly source. | Browser sends only allowlisted business parameters. |
| S3 | Dry-run review panel + conflict/default policy UI, including the selected synchronization strategy. | Review/evidence first; held rows remain held unless an existing policy explicitly permits otherwise. |
| S4 | Source snapshot + diff UI, including auto-discovery review tasks if separately authorized. | Private values stay in tenant runtime; public evidence values-free. |
| S5 | Apply-only entity-machine runbook for MetaSheet stock-preparation writes. | Package-from-main, values-free evidence, idempotency/re-pull proof. No K3/external write. |
| S6 | Procurement/warehouse/approval/notification workflow mapping. | Separate workflow/integration gates; no implicit PLM apply widening. |

## Acceptance locks

Future implementation PRs must keep these true:

```text
standardSolutionPreset=true
createOrBindTargetBeforeRun=true
targetReadinessValuesFree=true
projectNoOnlyRuntimeInput=true
browserCannotSupplySourceTargetPlanPayload=true
dryRunBeforeApply=true
freshTokenAndRevisionBeforeApply=true
humanFieldsPreserved=true
manualConfirmRowsHeld=true
missingChildBomHeld=true
largeBomRequiresAuthoritativeArtifact=true
sourceSnapshotDiffPosture=true
syncStrategyConfigurable=true
neverAutoOverwriteHumanFields=true
sourceDeletedRowsMarkInactiveNotDelete=true
fieldOptionSyncIsGenericCapability=true
plmWrite=false
externalDbWrite=false
k3Save=false
k3Submit=false
k3Audit=false
k3BomWrite=false
productionWrite=false
valuesFreePublicEvidence=true
```

## Stop rules

Stop the slice and do not proceed to merge if an implementation:

- lets the browser provide raw source/target/plan/payload material;
- writes or previews writes outside the MetaSheet stock-preparation target;
- writes a `manual_confirm` or `missing_child_bom` held row;
- overwrites a human-owned field without an explicit field-ownership contract;
- hard-codes one customer synchronization mode as the only supported behavior;
- auto-applies source changes without the selected strategy, source snapshot,
  audit, and review/dry-run posture required for that mode;
- treats a bounded large-BOM preview as authoritative;
- exposes forbidden values in public evidence, issue comments, fixtures, or
  logs;
- couples K3 Save / Submit / Audit / BOM write into this standard solution;
- silently changes the existing stock-preparation apply semantics instead of
  reusing the proven primitives.

## Relationship to adjacent issues

- #2253 remains the underlying PLM project BOM -> stock-preparation action line.
- #2343 remains duplicate-expanded-key policy history and future strategy
  routing.
- #2388 remains the source snapshot/diff lifecycle gate.
- #3020 remains the field-option-sync genericization line.
- #1709 remains the K3 WISE read/resolver/write boundary line.

This S0 document is the #3551 productization lock that organizes those lines
into one standard stock-preparation business solution.
