# Data Factory Field-Option Sync FOS-0 Design Lock

Date: 2026-06-21
Issue: #3020
Status: design-only / no runtime change

## 1. Problem

The Data Factory workbench currently exposes option synchronization through the
stock-preparation C6 surface:

- frontend service: `syncIntegrationStockPreparationOptions`;
- UI/test ids: `stock-option-sync-*`;
- backend route: `POST /api/integration/stock-preparation/options/sync`;
- implementation helper: `stock-preparation-option-sync.cjs`.

That implementation is safe and intentionally narrow, but the product surface is
business-specific. Data Factory is now the generic integration/workbench surface
for SQL, HTTP, ERP, PLM, MetaSheet staging, and own multitable targets. A visible
primary action named around stock preparation makes the generic page look like a
single-customer process panel.

FOS-0 locks the generic model before any runtime/UI rewrite.

## 2. Goal

Introduce a generic capability concept:

```text
capability=field-option-sync
primaryCommand=Sync options | Refresh field options
stockPreparation=first preset / compatibility path
```

A field-option sync refreshes select/dropdown option metadata for configured
MetaSheet fields from a trusted source. Stock-preparation option sync becomes one
preset under that capability, not the hard-coded primary action.

## 3. Non-goals

FOS-0 does not:

- add or change routes;
- rename UI controls;
- change runtime behavior;
- migrate existing stock-preparation config;
- introduce arbitrary SQL / JavaScript / URL / handler bodies;
- write PLM, K3, external databases, production/batch targets, or business rows;
- authorize first production external write.

## 4. Generic Contract

A field-option sync preset describes schema and policy, not credentials or row
values.

```text
presetId=<stable id>
label=<display label>
sourceKind=PLM|ERP|SQL|HTTP|MetaSheet staging|static preset
sourceSystemRef=<server-side binding, optional by preset>
sourceObjectOrTable=<config/object/table/view>
valueField=<option id/code/value field>
labelField=<option display field>
optionalGroupField=<category/domain field>
targetKind=metasheet:field-options
targetTable=<MetaSheet table/object binding>
targetField=<single-select|multi-select field>
syncMode=append|replace|disable_missing
conflictPolicy=keep_existing|update_from_source|manual_confirm
triggerMode=manual|scheduled|after_source_refresh
```

The browser must not supply executable behavior. Runtime slices must keep source
bindings and target field scoping server-side or admin-reviewed, mirroring the
existing C6 safety posture.

## 5. Preset Model

A preset is the product unit. The workbench can show a generic command and list
presets such as:

```text
preset=Stock-preparation option sync
fields=material type, blank type, preparation status, last PLM refresh decision
```

Future presets may cover material category, supplier class, warehouse, unit,
project status, process type, or customer-specific option domains.

Stock-preparation remains the compatibility anchor because it already proves:

- admin-only route/UI;
- field metadata patch through scoped provisioning API;
- values-free evidence;
- no arbitrary SQL/JS/URL/function body/payload;
- predefined action binding allowlist;
- no business-row write and no external write.

## 6. Current Stock-Preparation Grounding

The current stock-preparation option-sync implementation is the compatibility
anchor for the generic model. It already behaves like a narrow, metadata-only
field-option sync:

- `syncStockPreparationOptions(input)` patches MetaSheet field metadata through
  the scoped provisioning API; it does not write business rows, read PLM, call
  K3, or accept browser-provided SQL/JavaScript/handler bodies;
- the target is the canonical own-sheet stock-preparation table, not an
  external adapter target;
- access is admin-gated, the request shape is allowlisted, and executable keys,
  secret-shaped strings, and unresolved placeholders are rejected;
- evidence is values-free: field/source keys, option counts,
  action-binding counts, status/error codes, and skip reasons are allowed;
  option values, labels, source payloads, sheet ids, field ids, credentials,
  tokens, connection strings, raw SQL, and stack traces with values are not;
- the per-option normalizer is already mostly generic:
  `value`, optional `label`, `color` in `#RRGGBB` form, enabled/disabled state,
  optional `order`, and allowlisted `actionBindings`;
- the stock-preparation-specific pieces are the target table, field-to-sourceKey
  mapping, and action allowlist.

Current behavior is full `replace`: the source option set becomes the field's
option set. `append`, `disable_missing`, option-level `conflictPolicy`,
scheduled triggers, grouping/category fields, and dry-run/preview are not
implemented today and must stay behind later FOS slices.

## 7. Owner Decisions Before FOS-1

These defaults are the recommended v1 decisions. Changing any of them should be
an explicit owner call before FOS-1 implementation starts.

| Decision | Recommended v1 | Rationale |
| --- | --- | --- |
| Preset storage | Frozen reference-catalog constants | Matches the values-free S3-3 reference-template pattern, avoids a migration, and keeps FOS decoupled from S3 pipeline templates. Persisted custom presets can be a later opt-in. |
| `syncMode` default | `replace` | Mirrors the existing stock-preparation behavior and gives a zero-drift compatibility anchor. |
| `disable_missing` semantics | Disable only, never physically delete | Preserves history and human-added options; deletion semantics need their own review. |
| `conflictPolicy` default | `update_from_source` | Mirrors today's full metadata refresh. `keep_existing` and `manual_confirm` require new runtime behavior and tests. |
| `triggerMode` | `manual` only | Scheduled or after-source-refresh triggers need separate gates and observability. |
| Route naming | Add `POST /api/integration/field-options/sync`; keep the stock-preparation route as an alias/forwarder | Lets the generic capability become first-class without breaking existing clients/tests. |

## 8. UX Direction

The generic workbench surface should present:

```text
buttonLabel=Sync options | Refresh field options
presetLabel=Stock-preparation option sync
summaryBeforeRun=true
```

The pre-run summary should be count/shape based:

```text
source=<system/object label, no credentials>
target=<table/field label, no private ids in issue evidence>
mode=append|replace|disable_missing
estimatedChanges=count-only
```

Business-specific wording belongs in the preset label, helper text, or evidence
summary, not in the primary Data Factory action name.

## 9. Safety Locks

Every implementation slice must preserve these locks:

```text
adminOnly=true
valuesFreeEvidence=true
noCredentialsInRequest=true
noConnectionStringsInRequest=true
noRawSql=true
noJavaScript=true
noUrlHandlerBody=true
noFunctionBody=true
noClientSuppliedSheetScope=true
noClientSuppliedSourceTargetPlanPayload=true
noPlmWrite=true
noK3Save=true
noK3Submit=true
noK3Audit=true
noK3BomWrite=true
noExternalDbWrite=true
productionWrite=false
batchWrite=false
```

Evidence may include field/source keys, preset ids, option counts, action-binding
counts, sync modes, and status/error codes. Evidence must not include option
values, labels, source row payloads, credentials, tokens, connection strings,
sheet ids, field ids, raw SQL, or stack traces with values.

## 10. Compatibility and Migration

The current stock-preparation route remains the compatibility path until a
generic runtime route exists and is verified. Do not delete or silently change it
in FOS-0/FOS-1.

The migration should be staged:

1. expose the generic model alongside the stock-preparation preset;
2. prove the generic path emits the same values-free evidence for the existing
   preset;
3. switch UI wording to the generic command;
4. optionally retire stock-specific service names only after tests prove parity.

## 11. Slice Plan

### FOS-0 - Design lock

Docs-only. Lock the generic model, boundaries, migration posture, and acceptance
criteria. No runtime/UI changes.

### FOS-1 - Backend contract, stock preset only

Add a generic `field-option-sync` normalizer/contract and values-free preset
catalog constants, with stock-preparation as the first preset. This slice is
lock-safe and does not wire runtime or UI behavior.

Acceptance:

- existing stock-preparation C6 behavior remains unchanged;
- preset definitions cannot carry SQL/JS/URL/function body/payload;
- evidence is values-free;
- enum fields are strict for `sourceKind`, `syncMode`, `conflictPolicy`, and
  `triggerMode`;
- the stock-preparation preset is values-free and zero-drift-compatible with
  today's implementation.

### FOS-2 - Runtime generalization

Refactor stock-preparation option sync into a generic FOS kernel parameterized by
target object, field-to-sourceKey mapping, sync mode, conflict policy, and action
allowlist. Add the generic route and keep the existing stock-preparation route as
a compatibility alias/forwarder.

Acceptance:

- existing stock-preparation tests remain green and prove zero drift;
- generic route cannot carry SQL/JS/URL/function body/payload;
- non-admin fails closed;
- `replace` behavior matches today's stock-preparation behavior;
- any newly enabled `append`, `disable_missing`, or `conflictPolicy` behavior is
  covered by negative controls;
- evidence remains values-free.

### FOS-3 - UI generic surface

Rename the primary visible action to `Sync options` / `Refresh field options` and
show stock preparation as a preset. Business-specific labels remain in the preset
name and details, not the top-level Data Factory command.

Acceptance:

- Data Factory no longer exposes only a business-specific primary option-sync
  action;
- stock-preparation preset remains discoverable;
- no credential or source-row value appears in DOM evidence;
- request body stays scope-limited and values-free.

### FOS-4 - Additional preset authoring

Allow admin-reviewed creation of additional option-sync presets. This is the
first slice that may introduce new source/target configurations beyond the stock
preset, so it needs its own review and negative controls.

Scheduled or after-source-refresh triggers are separate demand-gated work and
must not ride on FOS-1/FOS-2/FOS-3.

## 12. Acceptance Criteria for #3020

```text
dataFactoryDoesNotExposeOnlyBusinessSpecificOptionSync=true
fieldOptionSyncCapabilityExists=true
stockPreparationOptionSyncRepresentedAsPreset=true
usersCanConfigureSourceObjectAndTargetField=true
usersCanChooseAppendReplaceDisableMissing=true
usersCanChooseConflictPolicy=true
manualRunDoesNotRequireCodeChange=true
valuesFreeEvidence=true
```

FOS-0 only satisfies the design portion of these criteria. Runtime satisfaction
requires FOS-1/FOS-2/FOS-3, and additional preset authoring remains gated behind
FOS-4 or later.
