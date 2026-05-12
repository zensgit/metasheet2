# Generic Integration Workbench Development Plan - 2026-05-12

## Summary

Build a generic integration workbench on top of the existing `plugin-integration-core` pipeline model. The product goal is:

1. connect any supported CRM / PLM / ERP / SRM / HTTP / SQL source;
2. land raw data into MetaSheet staging tables;
3. cleanse and review data in multitable views;
4. map clean rows to any supported target object;
5. preview the target payload;
6. run dry-run first;
7. push with Save-only by default;
8. write target IDs, document numbers, and errors back to integration feedback.

K3 WISE remains the first preset implementation. Its Material and BOM flows should become built-in target templates, not a one-off product direction. The K3 setup page remains as a quick-start wizard, while the generic workbench becomes the reusable configuration surface.

## Current Baseline

The repo already has the important backend primitives:

- `integration_external_systems` stores external connection metadata and encrypted credentials.
- `integration_pipelines` stores source/target system IDs, source/target objects, staging table ID, mode, options, and status.
- `integration_field_mappings` stores source field, target field, transform, validation, default value, and sort order.
- `integration_runs` and `integration_dead_letters` store run history and failed rows.
- Adapter contract already supports `testConnection`, `listObjects`, `getSchema`, `read`, and `upsert`.
- Existing adapter kinds include `http`, `plm:yuantus-wrapper`, `erp:k3-wise-webapi`, and `erp:k3-wise-sqlserver`.
- Transform engine already supports `trim`, `upper`, `lower`, `toNumber`, `toDate`, `defaultValue`, `concat`, and `dictMap`.
- Validator already supports `required`, `pattern`, `enum`, `min`, and `max`.

The immediate missing product layer is discovery and configuration UX:

- list available adapters with labels and capabilities;
- list objects and schemas for a selected external system;
- let users create mappings and templates without editing raw JSON;
- preview target payloads before running;
- present K3 WISE as a preset, not as the only path.

## Product Shape

### User Layers

| Layer | Users | Allowed configuration | Not allowed |
| --- | --- | --- | --- |
| Business user | operations / data owners | select systems, select objects, choose staging table, configure field mappings, dictionary mappings, validation rules, dry-run, Save-only push | raw SQL, user JavaScript, direct K3 core table writes, production Submit/Audit |
| Advanced implementer | delivery / admin users | configure HTTP paths, target templates, schema fields, response mapping, SQL read channel allowlists, middle-table writes | secrets in templates, absolute unsafe endpoints, direct core-table writes by default |
| Developer | product / plugin developers | add adapters, vendor auth flows, pagination, watermark logic, error dictionaries | runtime code execution from user config |

### Data Flow

```mermaid
flowchart LR
  A["Source system object"] --> B["Adapter read"]
  B --> C["Raw staging multitable"]
  C --> D["User cleansing and review"]
  D --> E["Field mappings + validation"]
  E --> F["Target template preview"]
  F --> G["Dry-run"]
  G --> H["Save-only target upsert"]
  H --> I["Feedback: external ID / bill number / errors"]
```

### Same-System Object Conversion

The workbench must support pipelines where the source and target system are the same external system, as long as the system role is `bidirectional`.

Examples:

| Scenario | Source | Target |
| --- | --- | --- |
| CRM internal cleansing | same CRM `customers_raw` | same CRM `customers_clean` |
| SRM supplier normalization | same SRM `supplier_candidates` | same SRM `suppliers` |
| K3 table-to-WebAPI correction | same K3 account through two logical connections | K3 WebAPI Save object |

Recommended UX:

- Allow `sourceSystemId === targetSystemId` only when the selected external system is `bidirectional`.
- Encourage two logical connections for physical systems that use different protocols:
  - `K3 WISE SQL read channel` as source;
  - `K3 WISE WebAPI write channel` as target.
- The UI should label this as "same system, different business object" instead of "loopback sync".

### SQL Channel as Advanced Feature

SQL channel is useful, but it must be treated as an advanced implementation surface:

- source-side SQL can read from allowlisted tables or views;
- target-side SQL can write only to configured middle tables by default;
- raw SQL is not accepted;
- identifiers must pass allowlist validation;
- direct K3 core table writes stay hidden and disabled unless explicitly enabled by an admin-only escape hatch;
- ordinary business users should see SQL channel only as "implemented by delivery/admin", not as a casual connector option.

## Backend Changes

### Adapter Discovery API

Add:

```http
GET /api/integration/adapters
```

Response shape:

```json
{
  "ok": true,
  "data": [
    {
      "kind": "http",
      "label": "HTTP API",
      "roles": ["source", "target", "bidirectional"],
      "supports": ["testConnection", "listObjects", "getSchema", "read", "upsert"],
      "advanced": false
    },
    {
      "kind": "erp:k3-wise-sqlserver",
      "label": "K3 WISE SQL Server Channel",
      "roles": ["source", "target"],
      "supports": ["testConnection", "listObjects", "getSchema", "read", "upsert"],
      "advanced": true
    }
  ]
}
```

Implementation:

- reuse `adapterRegistry.listAdapterKinds()`;
- add plugin-local metadata for labels, role hints, and advanced flags;
- never return credentials.

### Object Discovery API

Add:

```http
GET /api/integration/external-systems/:id/objects?tenantId=...&workspaceId=...
```

Behavior:

- load the scoped external system;
- create its adapter;
- call `adapter.listObjects()`;
- merge any `system.config.documentTemplates[]` target objects;
- redact all returned metadata.

### Schema Discovery API

Add:

```http
GET /api/integration/external-systems/:id/schema?tenantId=...&workspaceId=...&object=...
```

Behavior:

- call `adapter.getSchema({ object })`;
- if object is from `documentTemplates[]`, return the template schema;
- normalize fields to `{ name, label, type, required }`.

### Template Preview API

Add:

```http
POST /api/integration/templates/preview
```

Behavior:

- accepts `sourceRecord`, `fieldMappings`, and `template`;
- runs current transform and validation engine;
- returns `{ payload, valid, errors }`;
- does not call target adapter;
- does not write DB;
- redacts payload and errors before responding.

### Custom Target Templates

Store v1 templates in `integration_external_systems.config.documentTemplates`; do not add a new table in v1.

Template shape:

```json
{
  "id": "custom.supplier.v1",
  "version": "2026.05.v1",
  "label": "Supplier",
  "object": "supplier",
  "bodyKey": "Data",
  "endpointPath": "/Supplier/Save",
  "method": "POST",
  "keyFields": ["FNumber"],
  "schema": [
    { "name": "FNumber", "label": "Supplier code", "type": "string", "required": true },
    { "name": "FName", "label": "Supplier name", "type": "string", "required": true }
  ],
  "lifecycle": {
    "saveOnlyDefault": true,
    "allowSubmit": false,
    "allowAudit": false
  },
  "responseMapping": {
    "externalId": "Data.FItemID",
    "externalNumber": "Data.FNumber",
    "billNo": "Data.FBillNo",
    "errorCode": "ErrorCode",
    "errorMessage": "Message"
  }
}
```

Validation:

- `id`, `label`, and `object` are required;
- `endpointPath` must be relative;
- `bodyKey` defaults to `Data`;
- `schema[].name` is required;
- template content must not contain secrets;
- Save-only defaults to true.

### Pipeline Options

When a workbench creates a pipeline, store:

```json
{
  "targetTemplate": {
    "id": "k3wise.material.v1",
    "version": "2026.05.v1",
    "documentType": "material",
    "bodyKey": "Data",
    "source": "builtin"
  },
  "lifecycle": {
    "saveOnly": true,
    "autoSubmit": false,
    "autoAudit": false
  }
}
```

No change to the existing pipeline columns is required.

## Frontend Changes

Add:

- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`

Page flow:

1. choose source system;
2. choose target system;
3. test both connections;
4. choose source object and target object/template;
5. choose or install staging table;
6. configure field mappings;
7. configure validation and dictionary mappings;
8. preview payload;
9. dry-run;
10. Save-only run;
11. view feedback and dead letters.

K3 WISE setup page remains available as a shortcut:

- it should link to the generic workbench;
- tenant ID should come from current context;
- workspace ID should be advanced-only;
- WebAPI Base URL and relative endpoint path help text must avoid `/K3API/` duplication.

## Security Rules

- Never output credentials, tokens, authority codes, SQL connection strings, or bearer headers.
- Redact URL query secrets: `access_token`, `token`, `password`, `secret`, `sign`, `signature`, `api_key`, `session_id`, and `auth`.
- Do not allow user-provided JavaScript transforms.
- Do not allow raw SQL.
- Do not allow direct K3 core table writes in normal UI.
- Dry-run must not write target systems, create dead letters, or advance watermarks.
- Production Submit/Audit stays off until separately approved.

## Delivery Split

1. **PR-1: backend discovery and same-system guard tests**
   - adapters API;
   - object/schema discovery;
   - bidirectional same-system test;
   - design and verification docs.

2. **PR-2: template registry and preview API**
   - custom template validation;
   - preview endpoint;
   - no DB migration.

3. **PR-3: workbench service and shell UI**
   - system/object/schema selection;
   - mapping editor shell.

4. **PR-4: preview, dry-run, run feedback**
   - payload preview;
   - dry-run and Save-only run;
   - dead-letter display.

5. **PR-5: K3 WISE page convergence**
   - tenant/workspace UX cleanup;
   - endpoint path guidance;
   - link to generic workbench.

## Acceptance Criteria

- A user can configure source and target systems without entering tenant ID manually.
- A user can map source fields to target fields through the UI.
- A user can choose a K3 WISE built-in template or a custom target template.
- Same-system different-object pipelines work when the system is bidirectional.
- SQL channel is visible only as an advanced capability with allowlist guardrails.
- Dry-run produces a target payload preview and no external writes.
- Save-only run can write through a target adapter.
- Failure records go to dead letters and do not stop the whole batch.
- K3 WISE Material/BOM flows continue to pass existing offline PoC checks.
