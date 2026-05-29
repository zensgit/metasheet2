# Data Factory Template Composition Design - 2026-05-27

## Status / purpose

Draft design note. This document aligns the Data Factory template-composition
direction with the current codebase and defines the next smallest safe slice:
**DF-T1 Target Payload Template Preview**.

It is **not** a runtime implementation, migration plan, or authorization to
expand K3 Save / Submit / Audit / BOM / list / search / pagination /
multi-record writes. K3 WISE remains the first built-in template package, not
the center of the product.

Hard prerequisite: DF-T1 must not extend the current preview path while it is a
separate copy of the real Save body assembly. Before DF-T1 is implemented, K3
preview and K3 Save must share one body-composition source of truth, or a
byte-parity gate must prove that preview output equals the adapter Save body for
the same input. A misleading no-write preview is just a slower blind Save.

> **Scope boundary / related note.** This document covers only Data Factory
> template composition and target-payload preview — how cleansed multitable rows
> become a trustworthy target-system payload. It does **not** cover the external
> data-source connector base (credential encryption, read-only protection, owner
> scoping, supported-type matrix, connector extension boundary); that security /
> governance layer and its open-source benchmarking live in
> `docs/research/data-sources-oss-references-20260528.md`. The two are distinct
> subsystems — target-write payload composition here vs source-read connector
> base there — not a single feature. The only open-source references shared by
> both documents are n8n and Airbyte, applied to different problems (templates /
> actions / run evidence here; connector & credential governance there).

## Summary

This document defines how MetaSheet Data Factory should provide a reusable
template system for external-system integration. The goal is to let customers
connect CRM / PLM / ERP / SRM / HTTP / SQL systems, land data in multitables,
cleanse it in MetaSheet, then preview, export, or Save-only push to a target
system without asking MetaSheet developers to hard-code every customer-specific
field set.

K3 WISE is treated as the first built-in template package, not as the center of
the product. A K3 Material profile is a target payload template. A K3 BOM profile
is another target payload template. Future CRM customer, PLM item, SRM supplier,
or HTTP API objects follow the same model.

The preferred product shape is:

```text
Connector template
  -> dataset template
  -> multitable cleansing template
  -> target payload template
  -> no-write preview
  -> dry-run / export / Save-only
  -> run log / dead letter / provenance
```

The important policy decision is that MetaSheet should not define the customer's
business-required target fields. MetaSheet should provide template authoring,
field rules, validation, preview, redaction, run evidence, and replay/rollback
boundaries. Customer operators provide or approve the target payload profile.

## Open-source reference findings

This design is inspired by several open-source systems, but does not copy any
one of them wholesale.

| Project | Source observed | Useful idea | What MetaSheet should avoid |
|---|---|---|---|
| Apache NiFi | `ParameterContext` separates parameter context, inherited parameters, update verification, and provider configuration. | Separate templates from environment-specific parameters and secrets. Treat secret-bearing values as runtime parameters, not template content. | Do not build a full visual NiFi-style processor canvas in v1. |
| Airbyte CDK | `YamlDeclarativeSource` loads a YAML manifest. `HttpRequester` separates URL/path/auth/body/options. `SimpleRetriever` orchestrates requester, selector, paginator, slicer. `RecordSelector` extracts, filters, transforms, and normalizes records. | Use declarative connector pieces: requester, extractor, paginator, field selection, and transform. | Do not build a complete Airbyte-compatible connector platform before the K3/Data Factory PoC is stable. |
| Meltano/Singer SDK | `Stream` owns schema, state, primary keys, selected fields, and type conformance. `mapper` handles stream maps, aliases, filters, and flattening. | Keep source, target, mapper, schema, and state as separate concepts. | Do not bypass MetaSheet multitables and turn Data Factory into a pure headless ETL tool. |
| Node-RED | Runtime flow code separates flow config, credentials, deploy diff, missing types, and active runtime. | Template import/export and credentials separation are valuable. Deploy-time diff is useful before changing a running integration. | Do not expose a node graph editor or arbitrary node execution in v1. |
| n8n | Workflow model separates nodes, connections, parameters, credentials, static data, and execution data. | Use form-driven node/step parameters and keep credentials out of workflow templates. | Do not introduce broad workflow automation semantics into Data Factory's first template slice. |
| Enterprise connector products | Connector data source -> connector -> action; HTTP action inputs are grouped as path/query/header/body; function-style actions use body inputs; response output can be unwrapped by a configured result path; action metadata carries input and output definitions. | Model Data Factory connectors as templates with named actions, typed inputs, output unwrap rules, action-level safety policy, and no-write preview. | Do not expose page-level JavaScript connector calls or bypass the multitable cleansing hub. |

Reference links:

- Apache NiFi `ParameterContext`: <https://github.com/apache/nifi/blob/main/nifi-framework-bundle/nifi-framework/nifi-framework-core-api/src/main/java/org/apache/nifi/parameter/ParameterContext.java>
- Airbyte `YamlDeclarativeSource`: <https://github.com/airbytehq/airbyte-python-cdk/blob/main/airbyte_cdk/sources/declarative/yaml_declarative_source.py>
- Airbyte `HttpRequester`: <https://github.com/airbytehq/airbyte-python-cdk/blob/main/airbyte_cdk/sources/declarative/requesters/http_requester.py>
- Airbyte `SimpleRetriever`: <https://github.com/airbytehq/airbyte-python-cdk/blob/main/airbyte_cdk/sources/declarative/retrievers/simple_retriever.py>
- Airbyte `RecordSelector`: <https://github.com/airbytehq/airbyte-python-cdk/blob/main/airbyte_cdk/sources/declarative/extractors/record_selector.py>
- Airbyte `AddFields`: <https://github.com/airbytehq/airbyte-python-cdk/blob/main/airbyte_cdk/sources/declarative/transformations/add_fields.py>
- Meltano/Singer `Stream`: <https://github.com/meltano/sdk/blob/main/singer_sdk/streams/core.py>
- Meltano/Singer `mapper`: <https://github.com/meltano/sdk/blob/main/singer_sdk/mapper.py>
- Node-RED flow runtime: <https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/runtime/lib/flows/index.js>
- n8n workflow model: <https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/workflow.ts>

## Existing MetaSheet anchors

MetaSheet already has most of the needed building blocks:

- `plugins/plugin-integration-core/lib/contracts.cjs` already defines the
  narrow adapter contract: `testConnection`, `listObjects`, `getSchema`,
  `read`, and `upsert`.
- `config.documentTemplates[]` is already recognized by integration HTTP routes
  and merged into object discovery.
- `/api/integration/templates/preview` already accepts `sourceRecord`,
  `fieldMappings`, and `template`, runs transform/validation, and returns a
  no-write payload preview. This route is the DF-T1 extension point; DF-T1
  should not create a parallel preview engine.
- The current preview route is not yet sufficient for K3 Save approval evidence:
  it has its own reference shaping and projection helpers. K3 Save now has
  additional semantics in the adapter: customer-profile preset handling,
  fail-closed placeholder validation, Save-only lifecycle locks, object
  passthrough, and row diagnostics. DF-T1 must converge those paths before
  operators use preview evidence to approve Save-only.
- K3 WISE Material/BOM templates already exist in
  `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`.
- The K3 Material customer-profile backend preset now exists on main as
  `material-k3wise-customer-profile-v1`: explicit opt-in only, Save-only hard
  lock, placeholder fail-closed, conservative diagnostics, and no customer
  dictionary values committed to Git.
- `metasheet:staging` can read cleansing multitables as a source adapter.
- `metasheet:multitable-target` can materialize cleansed outputs into another
  multitable.
- `pipeline-runner.cjs` already provides the linear NiFi-inspired path:
  source read -> transform -> validate -> target upsert -> run log ->
  dead letter -> replay.
- Pipeline run details already carry target write summaries and dead-letter
  status. DF-N1 / DF-N1.5 made those visible in the Data Factory run-monitoring
  surface.
- DF-N2-1 provenance contracts are on main; row-level provenance runtime remains
  a separate gated slice.

The missing product layer is not a generic "ETL engine." The missing layer is a
target payload template authoring surface that can preserve customer-provided
target object defaults and replace only approved fields.

## NiFi-inspired operating model

Data Factory should borrow Apache NiFi's operating discipline, not its full
visual canvas. The user-facing product remains multitables, forms, preview, and
run monitoring. NiFi-like concepts stay inside the Data Factory kernel as
governance primitives.

| NiFi concept | MetaSheet equivalent | How to use it |
|---|---|---|
| Parameter Context | Environment parameters and connector parameters | Keep environment-specific values outside templates. Templates may reference placeholders; runtime profiles resolve them. |
| Controller Service | Connector Profile | Reuse one approved connection profile across actions, datasets, and pipelines. |
| Processor | Connector Action | Model each safe operation as a named action with typed inputs, output unwrap rules, and safety policy. |
| FlowFile content | Multitable row / payload body | Treat the business row and composed target payload as the unit of work. |
| FlowFile attributes | Row provenance attributes | Record source row id, pipeline id, mapping version, target object, action id, run id, and redacted result metadata. |
| Provenance | Integration run log + row result + dead letter | Make every row explainable: where it came from, which mapping touched it, what target payload was produced, and why it failed or passed. |
| Failure route | Dead-letter view | Failed rows go to a visible exception path instead of stopping the whole batch. |
| Backpressure | Bounded retry / approval gates | Prevent unbounded retries and broad writes; require explicit gates for risky operations. |

Design rules:

- Keep the runtime linear for v1: read -> transform -> validate -> preview or
  upsert -> run log -> dead letter.
- Do not add a general node canvas, arbitrary processors, user JavaScript, or
  free-form scheduling in this slice.
- Keep queue and retry semantics operator-readable: row status, error code,
  retry count, idempotency key, and dead-letter state.
- Treat provenance as an audit contract, not a nice-to-have log. Redacted
  provenance is required for customer evidence, rollback, and safe replay.
- Let multitables remain the business cleansing surface. Data Factory should not
  become a headless ETL tool that hides the data from business operators.

## Proposed template model

### 1. Connector Profile

Connector profiles describe how to connect to a system. They do not describe
business fields.

```json
{
  "id": "k3wise-webapi-default",
  "kind": "erp:k3-wise-webapi",
  "label": "K3 WISE WebAPI",
  "params": {
    "baseUrl": "{{K3_BASE_URL}}",
    "account": "{{K3_ACCOUNT}}"
  },
  "secretsRef": {
    "authorityCode": "secret://k3/authorityCode"
  },
  "security": {
    "secretsInTemplate": false,
    "allowRawSql": false,
    "allowUserJavascript": false
  }
}
```

Design rules:

- Templates may include parameter names and placeholders.
- Templates must not include actual tokens, passwords, authority codes, cookies,
  SQL connection strings, or host-specific credentials.
- Connection testing remains separate from payload preview.

### 2. Connector Action

Connector actions describe one safe operation exposed by a connector profile.
They bridge connector connection settings and dataset/template behavior. A
connector can expose several actions, for example `getMaterialDetail`,
`previewMaterialSave`, `saveMaterial`, or `exportCsv`.

```json
{
  "id": "k3wise.material.get-detail",
  "connectorKind": "erp:k3-wise-webapi",
  "operation": "read",
  "label": "Material GetDetail",
  "request": {
    "method": "POST",
    "path": "/K3API/Material/GetDetail",
    "inputs": {
      "path": [],
      "query": [],
      "header": [],
      "body": [
        { "name": "Number", "source": "record.FNumber", "required": true }
      ]
    }
  },
  "response": {
    "successPath": "StatusCode",
    "successValue": 200,
    "recordPath": "Data[0].Data",
    "errorPath": "Message"
  },
  "safety": {
    "readOnly": true,
    "allowBatch": false,
    "maxRowsPreview": 1,
    "allowUserJavascript": false
  }
}
```

Design rules:

- Actions are named capabilities, not free-form user HTTP requests.
- HTTP-like actions split inputs into `path`, `query`, `header`, and `body` so
  the UI can explain what each input affects.
- Function-style actions may use only `body` inputs, but they still need an
  output schema and a response unwrap rule.
- Header inputs must never accept secrets directly from business users; secret
  values come from `secretsRef`.
- Each action declares whether it is `read`, `preview`, `upsert`, or `export`.
  Save-only and write actions remain separately approved.
- Action output is unwrapped by a configured path before it is shown in the
  Data Factory preview or written into a staging multitable.

For v1, connector actions are metadata around existing adapter methods. They do
not authorize a generic HTTP client, user JavaScript, direct SQL, or a new
connector runtime.

### 3. Dataset Template

Dataset templates describe the source or target object shape.

```json
{
  "id": "k3wise.material.detail.readonly.v1",
  "systemKind": "erp:k3-wise-webapi",
  "object": "material",
  "operation": "read",
  "request": {
    "method": "POST",
    "path": "/K3API/Material/GetDetail",
    "body": {
      "Number": "{{record.FNumber}}"
    }
  },
  "extractor": {
    "recordPath": "Data[0].Data"
  },
  "schema": [
    { "name": "FNumber", "type": "string", "required": true },
    { "name": "FName", "type": "string", "required": true }
  ],
  "safety": {
    "readOnly": true,
    "maxRowsPreview": 1
  }
}
```

For v1, dataset templates should support only:

- static request path;
- controlled headers/body/query fields;
- JSON extraction path;
- optional paging only after the single-record path is stable;
- no arbitrary JavaScript;
- no raw SQL editor.

### 4. Multitable Cleansing Template

This is where MetaSheet is different from Airbyte or NiFi. Business users should
work primarily in multitables.

A cleansing template can create or guide these sheets:

| Sheet | Purpose |
|---|---|
| Raw source sheet | Imported/source rows, minimally changed. |
| Cleansing sheet | Business-owned normalized rows. |
| Reference mapping sheet | Source code to target reference object mapping. |
| Run feedback fields | Sync status, external id, bill no, error code, error message. |
| Exception/dead-letter view | Failed rows and retry/discard status. |

K3 Material example:

```text
standard_materials
  materialCode
  materialName
  materialSpec
  unitSourceCode
  unitRefObject
  erpSyncStatus
  erpExternalId
  erpErrorCode
  erpErrorMessage

k3_unit_mapping
  sourceCode
  k3FNumber
  k3FName
  k3FID
  enabled
  description
```

The reference mapping sheet follows the prior K3 reference-object design:
one row represents one full K3 reference object, not just a single code.

### 5. Target Payload Template

Target payload templates describe how to build the final outbound request body.
This is the core of the proposal.

```json
{
  "id": "k3wise.material.customer-profile.v1",
  "label": "K3 WISE Material - Customer Profile",
  "systemKind": "erp:k3-wise-webapi",
  "object": "material",
  "mode": "template-clone",
  "target": {
    "method": "POST",
    "path": "/K3API/Material/Save",
    "bodyKey": "Data"
  },
  "payloadTemplate": {
    "FUnitGroupID": { "FNumber": "<unit-group-number>", "FName": "<unit-group-name>" },
    "FUnitID": { "FNumber": "<unit-number>", "FName": "<unit-name>" },
    "FOrderUnitID": { "FNumber": "<order-unit-number>", "FName": "<order-unit-name>" },
    "FSaleUnitID": { "FNumber": "<sale-unit-number>", "FName": "<sale-unit-name>" },
    "FProductUnitID": { "FNumber": "<product-unit-number>", "FName": "<product-unit-name>" },
    "FStoreUnitID": { "FNumber": "<store-unit-number>", "FName": "<store-unit-name>" }
  },
  "fieldRules": [
    {
      "targetField": "FNumber",
      "sourceType": "from_staging",
      "sourceField": "materialCode",
      "required": true,
      "replacePolicy": "replace"
    },
    {
      "targetField": "FName",
      "sourceType": "from_staging",
      "sourceField": "materialName",
      "required": true,
      "replacePolicy": "replace"
    },
    {
      "targetField": "FUnitID",
      "sourceType": "preserve_template",
      "shape": "object-passthrough",
      "required": true,
      "replacePolicy": "preserve"
    }
  ],
  "safety": {
    "saveOnly": true,
    "autoSubmit": false,
    "autoAudit": false,
    "failOnUnresolvedPlaceholders": true
  }
}
```

Supported `sourceType` values for v1:

| Source type | Meaning |
|---|---|
| `from_staging` | Read from the cleansed multitable row. |
| `from_constant` | Use a constant configured by the operator. |
| `preserve_template` | Keep the value from `payloadTemplate`. |
| `from_reference_table` | Resolve one scalar component from a multitable dictionary row, if already available. |

`from_reference_table` is intentionally narrow in v1. The #1824 probe showed
that a single multitable lookup produces an array of one target field's raw
values; it cannot synthesize a two-field object such as `{ FName, FNumber }` by
itself. Therefore v1 reference-table rules may resolve scalar components only.
Multi-component K3 reference objects must either already exist as an object in
the source row, be composed by the existing client-side reference-completeness
preview, or wait for a separately unlocked server-side composition path.

Supported composition `shape` values for v1:

| Shape | Meaning |
|---|---|
| `scalar` | Write the scalar value as-is. |
| `object-passthrough` | Input value must already be a full object; preserve it. |
| `by-fnumber` | Wrap scalar as `{ "FNumber": value }`. |
| `by-fid` | Wrap scalar as `{ "FID": value }`. |

Supported completeness rules for reference objects:

| Completeness rule | Meaning |
|---|---|
| `none` | No additional component requirement beyond the composition shape. |
| `require-fnumber-fname` | Require both `FNumber` and `FName` to be present before the row can be treated as ready. |
| `require-fid-fname` | Require both `FID` and `FName` to be present before the row can be treated as ready. |

For K3, composition and completeness must stay separate:

- composition shape is owned by the shared Save-body composer and is covered by
  byte-parity tests;
- completeness is a validation/readiness concern and is covered by preview
  readiness tests;
- adapter `applyReferenceShape` does not enforce two-component completeness; it
  wraps scalar values by identifier and preserves existing objects. Do not make
  parity tests imply that Save composition validates `FName` presence.

The template engine must fail closed if any placeholder such as
`<unit-number>` reaches the Save body.

### Compatibility with shipped K3 reference mechanisms

The shape names above are general template-layer vocabulary. For K3, DF-T1 must
compile or route them through the shipped mechanisms instead of creating a
second K3-specific shaping path:

- scalar reference wrapping and object passthrough must remain compatible with
  the adapter's `applyReferenceShape` behavior;
- two-component requirements such as `require-fnumber-fname` and
  `require-fid-fname` are completeness/readiness rules, not a second Save-body
  shaping path;
- per-field shape intent must continue to persist through
  `config.objects.material.schema[*].reference.identifier` and `passthrough`;
- bounded completeness preview should reuse the shipped K3 reference preview
  helper rather than introducing sibling shape logic.

This avoids drift between the preview path and the real K3 Save path.

### K3 composition single source of truth

K3 target payload preview must be generated by the same body composition logic
that the adapter uses for Save. This is a merge prerequisite, not an optional
cleanup.

Current drift that DF-T1 must remove:

| Concern | Real K3 Save path | Current preview path | Required DF-T1 rule |
|---|---|---|---|
| Reference shaping | Adapter `applyReferenceShape` | HTTP route `applyPreviewReferenceShape` copy | One shared shaper or a parity gate. |
| Projection | Adapter `projectRecordForBody` drops blank values and uses object config | HTTP route `projectRecordForTemplate` keeps different nested-path semantics | Preview must use the same projection as Save for K3. |
| Placeholder fail-closed | Adapter rejects bare `<...>` placeholders before HTTP Save | Preview currently can produce a payload with placeholders | Preview must fail closed on the same placeholders. |
| Customer profile preset | Adapter applies `material-k3wise-customer-profile-v1` only on explicit opt-in | Preview receives caller-supplied template and does not apply the preset | Preview must resolve the same explicit profile. |
| Save-only locks | Adapter strips Submit/Audit and forces auto flags off for save-only profiles | Preview has no lifecycle lock semantics | Preview evidence must show the same lock state. |

Implementation seam options:

- **Option A - adapter dry-call seam**: preview asks the adapter to compose a
  body without login or HTTP fetch. This is small, but must avoid `login()` and
  `normalizeUpsertRequest` side effects.
- **Option B - shared composer module (preferred)**: extract
  `buildSaveBody`, `projectRecordForBody`, `applyReferenceShape`,
  fail-closed placeholder scanning, and preset resolution into a shared
  composer such as `lib/k3-save-body-composer.cjs`. The adapter and preview
  route both import it.

Non-negotiable gates:

- Add a parity test: `previewPayload.Data` must equal the adapter-composed Save
  body `Data` for the same K3 profile, schema, and staging row.
- Add a placeholder parity test: the same unresolved placeholder must fail in
  preview and in Save composition with the same error code.
- Add a preset opt-in test: preview does not silently switch the default K3
  Material template to `material-k3wise-customer-profile-v1`.
- Add a grep-style guard or review gate so a new K3-specific preview reference
  shaper is not reintroduced beside the adapter shaper.

### 6. Pipeline Template

Pipeline templates bind connector, dataset, multitable, field mappings, and
target payload template into a repeatable workflow.

```json
{
  "id": "k3wise.material.staging-to-saveonly.v1",
  "source": {
    "systemId": "metasheet-staging",
    "object": "standard_materials"
  },
  "target": {
    "systemId": "customer-k3-webapi",
    "object": "material",
    "payloadTemplateId": "k3wise.material.customer-profile.v1"
  },
  "fieldMappings": [
    { "sourceField": "materialCode", "targetField": "FNumber", "transform": ["trim", "upper"] },
    { "sourceField": "materialName", "targetField": "FName", "transform": ["trim"] }
  ],
  "runPolicy": {
    "mode": "manual",
    "dryRunRequired": true,
    "saveOnly": true,
    "maxRowsPerApprovedRun": 1
  }
}
```

## User workflow

1. User selects a template package, for example `K3 WISE`.
2. User creates or selects a connector profile.
3. User creates staging and mapping multitables from template.
4. User imports or pastes a target payload template:
   - for K3, this can be a sanitized `GetDetail` sample from an existing valid
     material;
   - secrets and host/account details are forbidden;
   - unresolved placeholders are allowed only before preview, never before Save.
5. User maps staging fields to target fields.
6. User runs no-write preview:
   - final payload shape;
   - missing required fields;
   - unresolved references;
   - placeholder failures;
   - target field provenance: staging/template/constant/reference table.
7. User exports preview evidence or runs dry-run.
8. Save-only requires explicit approval and remains separate from Submit/Audit.
9. Run monitor shows row-level success/failure and dead-letter status.

## Contextual next-reading panel

Data Factory should include a right-side contextual help panel on template,
connector, preview, run-monitoring, and error pages. The panel is not a
marketing surface. It is a task-aware guide that helps operators find the next
relevant action without leaving the workflow.

Recommended panel sections:

| Section | Content | Trigger |
|---|---|---|
| Current step | One-sentence description of what the current page configures. | Always visible. |
| Required evidence | What must be captured before moving forward, for example no-write preview JSON, dry-run result, or customer approval. | Visible on preview, dry-run, and Save-only gates. |
| Related setup | Links to connector profile, dataset action, staging multitable, mapping sheet, and target payload template used by the current pipeline. | Visible after a pipeline/template is selected. |
| Troubleshooting | Links to the dead-letter view, redacted diagnostics, package/runbook, and known boundary notes. | Visible on failed tests, failed previews, or failed runs. |
| Locked boundaries | Short reminder of what this page does not authorize, for example Submit/Audit/BOM/multi-record writes. | Visible on K3 and other gated templates. |
| Next reading | Contextual documentation links for the selected connector/action/template. | Visible after a connector or template package is selected. |

The panel should be generated from template metadata rather than hard-coded
page copy. A template package can contribute:

```json
{
  "help": {
    "currentStep": "Configure the Material Save-only target payload preview.",
    "relatedDocs": [
      {
        "id": "k3-material-profile",
        "label": "Material customer-profile payload rules",
        "href": "docs/development/integration-k3wise-m1-material-save-failure-fix-design-20260527.md"
      }
    ],
    "boundaries": [
      "Save-only is separate from Submit/Audit.",
      "BOM and multi-record expansion remain locked."
    ],
    "evidenceChecklist": [
      "No-write preview has no unresolved placeholders.",
      "Diagnostics are redacted.",
      "Customer approval is recorded before Save-only."
    ]
  }
}
```

For v1, the next-reading panel is read-only UI over existing docs and template
metadata. It must not execute actions, bypass gates, or hide required approval
steps. It should be implemented as a small Data Factory component that receives
`connectorProfile`, `connectorAction`, `datasetTemplate`, `targetPayloadTemplate`,
and `runState` as inputs and renders links/checklists from metadata.

## K3 WISE template package

K3 WISE should be delivered as a built-in template package:

| Template | Status | Notes |
|---|---|---|
| K3 Material minimal template | Existing | Useful for preview and early smoke only. |
| K3 Material customer-profile backend preset | Existing on main | Opt-in only; Save-only hard lock; structure only; no customer values in Git. |
| K3 Material customer-profile authoring UI | Needed | Operator-facing payload/profile configuration and no-write preview. |
| K3 BOM template | Existing / locked | Keep locked until Material path is stable. |
| K3 reference mapping sheet template | Needed | Unit, unit-group, account, warehouse, category. |
| K3 rollback checklist | Existing design track | Required before broader Save expansion. |

The K3 Material customer profile must be opt-in. The default K3 Material
template must never silently switch to the customer profile.

## Security rules

- No secrets in template manifests.
- No raw SQL editor in business UI.
- No user-authored JavaScript transforms.
- Endpoint paths must be relative to the connector base URL.
- Preview output and run details must pass shared payload redaction.
- Target payload templates must fail closed on unresolved placeholders.
- Save-only, Submit, Audit, BOM, list/search, pagination, and production
  multi-record expansion are separate approvals.

## Phased implementation plan

### DF-T0 - Contract document

- [x] Define the template layers and open-source references in this document.
- [x] State that K3 is a built-in template package, not the whole product.
- [x] State that customer target fields are supplied/configured by customer
  operators, not hard-coded by MetaSheet.

### DF-T1 - Target Payload Template Preview

- [ ] First converge K3 preview and K3 Save body composition into a single
  source of truth or equivalent byte-parity seam.
- [ ] Do not accept DF-T1 preview evidence for K3 Save-only approval until the
  parity tests below are green.
- [ ] Extend the existing `/api/integration/templates/preview` model with
  `payloadTemplate` and `fieldRules`; do not create a parallel preview route.
- [ ] Implement no-write merge preview:
  `payloadTemplate + fieldRules + staging record -> final payload`.
- [ ] Preserve whole-object defaults from `payloadTemplate` and replace only
  fields explicitly declared by `fieldRules`.
- [ ] Fail on unresolved placeholders.
- [ ] Keep this preview read-only; do not call any external target.
- [ ] Reuse existing K3 reference shaping / shape persistence / completeness
  preview semantics where the target is K3.
- [ ] For K3, preview must fail closed on the same unresolved placeholders that
  would fail before adapter Save.
- [ ] For K3, preview must resolve the same explicit customer-profile preset and
  Save-only lifecycle metadata as adapter Save.

### DF-T1A - Connector action metadata

- [ ] Add connector action metadata for the first target package without adding
  a generic HTTP client runtime.
- [ ] Represent action inputs as `path`, `query`, `header`, and `body` groups.
- [ ] Add response unwrap metadata: success path, error path, record path.
- [ ] Bind dataset templates to connector actions instead of duplicating request
  metadata in every dataset.
- [ ] Keep Save-only and write actions hidden or disabled unless their explicit
  gate is satisfied.

### DF-T1.5 - Preview provenance display

- [ ] Show per-field provenance: staging, template, constant, or reference table.
- [ ] Keep this display read-only and derived from the DF-T1 merge result.
- [ ] Do not persist a new provenance runtime field in this slice.

### DF-T2 - K3 Template Clone Preview

- [ ] Add a K3 Material customer-profile template authoring surface.
- [ ] Allow a sanitized `GetDetail` body sample to become `payloadTemplate`.
- [ ] Let the operator choose replace/preserve rules for `FNumber`, `FName`,
  `FModel`, and reference fields.
- [ ] Validate full reference object shapes.
- [ ] Show why a row is not ready before Save.

### DF-T3 - Multitable Template Authoring

- [ ] Add a "create from template" action for reference mapping sheets.
- [ ] Create or guide sheets for unit, unit-group, account, warehouse, and
  category dictionaries.
- [ ] Keep dictionary content customer-owned.
- [ ] Support export/import of template manifests without secrets.

### DF-T4 - Pipeline Template Binding

- [ ] Bind connector profile, staging object, field mappings, and target payload
  template into a pipeline template.
- [ ] Persist template version metadata in pipeline options.
- [ ] Keep dry-run mandatory before Save-only.
- [ ] Record run provenance and row-level results.

### DF-T5 - Template Center

- [ ] Add a Data Factory template center with built-in templates and copied
  customer templates.
- [ ] Support import/export of non-secret template manifests.
- [ ] Add diff view before applying template updates.
- [ ] Add package verification markers for built-in template packages.

### DF-T6 - Contextual next-reading panel

- [ ] Add a Data Factory right-side help panel driven by connector/template
  metadata.
- [ ] Show current step, related setup, required evidence, troubleshooting links,
  locked boundaries, and next reading.
- [ ] Link to existing local docs/runbooks by stable relative path.
- [ ] Keep it read-only; do not trigger connector actions from this panel.
- [ ] Add tests that K3 pages show Save-only boundaries and do not mention
  Submit/Audit as available next actions.
- [ ] Treat this as a UI follow-up, not as a prerequisite for the K3 payload
  preview parity fix.

## Validation plan

### Unit tests

- `payloadTemplate` merge preserves untouched template fields.
- `from_staging` replaces only declared fields.
- `preserve_template` keeps customer defaults.
- unresolved placeholder before Save returns a validation failure.
- object passthrough preserves `{ FNumber, FName }` and `{ FID, FName }`.
- scalar wrapping works only when the selected shape allows it.
- K3 preview and adapter Save body composition produce the same `Data` object
  for the same explicit profile, schema, and staging row.
- K3 preview and adapter Save composition fail on the same unresolved
  placeholders with the same error code.
- default K3 Material preview does not silently opt into
  `material-k3wise-customer-profile-v1`.
- preview redacts connection strings, tokens, authority codes, and passwords.

### Frontend tests

- Data Factory shows template package selection.
- K3 WISE appears as a built-in package.
- User can choose a target payload template.
- Preview displays field provenance and unresolved fields.
- Connector action forms group inputs by path/query/header/body.
- Contextual next-reading panel shows current step, related setup, locked
  boundaries, and docs links from template metadata.
- Save-only action is disabled until preview is clean and explicit approval is
  present.

### Integration tests

- `/api/integration/templates/preview` remains no-write.
- K3 preview does not call login, fetch, Submit, Audit, BOM, list/search, or
  pagination while composing the body.
- `config.documentTemplates[]` discovery still works.
- staging source to template preview works without external network.
- K3 customer profile remains opt-in.
- default K3 Material template remains byte-stable unless explicitly changed.

## Non-goals for this slice

- No visual ETL canvas.
- No arbitrary workflow engine.
- No user JavaScript transforms.
- No raw SQL editor.
- No automatic K3 Submit/Audit.
- No BOM Save expansion.
- No production multi-record push.
- No automatic discovery of every K3 object.

## Recommendation

Proceed with **DF-T1 only** first, but split its first move clearly:

1. **DF-T1-0 K3 composition parity**: converge K3 preview and K3 Save body
   composition into a single source of truth, or prove byte parity through a
   dedicated seam. This is required before preview output can be used as
   operator evidence for Save-only approval.
2. **DF-T1 Target Payload Template Preview**: extend the existing
   `/api/integration/templates/preview` route with `payloadTemplate` and
   `fieldRules` after parity is locked.

This is still the smallest slice that proves the new product model while
avoiding another blind K3 Save attempt. Without DF-T1-0, the preview can drift
from Save and become misleading.

DF-T1 should prove one capability: a customer/operator can combine a sanitized
whole-object `payloadTemplate`, declarative `fieldRules`, and one sample staging
record into the exact final payload that would later be used by dry-run or
Save-only. It must perform zero external calls and fail closed on unresolved
placeholders.

Per-field provenance display, contextual next-reading UI, K3 customer-profile
authoring UI, template center, pipeline-template binding, and connector catalog
work remain follow-up slices.
