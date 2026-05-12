# Generic Integration Workbench Template Preview Design - 2026-05-12

## Purpose

The workbench needs a safe way to show users what a mapped record will look like before any ERP/CRM/PLM/SRM write happens. This slice adds a pure preview endpoint:

```http
POST /api/integration/templates/preview
```

The endpoint transforms one sample source record into a target payload, validates it, wraps it with the target template `bodyKey`, and returns structured errors. It does not read or write database state and does not call any external adapter.

## Request Shape

```json
{
  "sourceRecord": {
    "code": " mat-001 ",
    "name": " Bolt ",
    "uom": "EA"
  },
  "fieldMappings": [
    {
      "sourceField": "code",
      "targetField": "FNumber",
      "transform": ["trim", "upper"],
      "validation": [{ "type": "required" }]
    }
  ],
  "template": {
    "id": "k3wise.material.v1",
    "version": "2026.05.v1",
    "documentType": "material",
    "bodyKey": "Data",
    "endpointPath": "/K3API/Material/Save",
    "schema": [
      { "name": "FNumber", "label": "Material code", "type": "string", "required": true }
    ]
  }
}
```

`template` is optional. When absent, `bodyKey` defaults to `Data` and the full transformed target record is returned.

## Response Shape

```json
{
  "ok": true,
  "data": {
    "valid": true,
    "payload": {
      "Data": {
        "FNumber": "MAT-001"
      }
    },
    "targetRecord": {
      "FNumber": "MAT-001"
    },
    "errors": [],
    "transformErrors": [],
    "validationErrors": [],
    "schemaErrors": [],
    "template": {
      "id": "k3wise.material.v1",
      "version": "2026.05.v1",
      "documentType": "material",
      "bodyKey": "Data",
      "endpointPath": "/K3API/Material/Save"
    }
  }
}
```

## Behavior

1. Require `integration:write` or admin permission because preview is part of pipeline authoring.
2. Require `sourceRecord` to be a plain object.
3. Require `fieldMappings` to be an array.
4. Reuse `transformRecord()` from `transform-engine.cjs`.
5. Reuse `validateRecord()` from `validator.cjs`.
6. Apply template-schema required checks for fields marked `required: true`.
7. Project the target record to the template schema when a schema is provided.
8. Wrap the projected record as `{ [bodyKey]: targetRecord }`.
9. Pass the final response through `sanitizeIntegrationPayload()`.

## Safety Rules

- Preview never calls `adapter.read()` or `adapter.upsert()`.
- Preview never writes `integration_*` tables.
- Preview rejects unsafe body keys such as `__proto__`, `prototype`, and `constructor`.
- Preview rejects absolute or scheme-bearing template endpoint paths.
- Preview does not execute user JavaScript; unsupported transforms become structured transform errors.
- Preview response avoids shared object references before redaction so JSON output cannot degrade into `[circular]` placeholders for normal payload data.

## Non-Goals

- No pipeline creation.
- No dry-run execution.
- No adapter discovery changes beyond the previous slice.
- No frontend page in this slice.
