# Data Factory PLM stock-preparation target readiness runbook (C1b-2)

Use this runbook on the entity machine before resuming the #2253 full C5 smoke.
C1b-2 prepares the **target table metadata** only. It does not read PLM, write
business rows, apply a plan, call K3, write an external database, or sync custom
options.

## Preconditions

- You are signed in as an integration admin.
- The deployed package includes #2307 and the C1b-2 route slice.
- You know the tenant context. If no `projectId` is supplied, the backend uses
  the plugin-scoped default `<tenantId>:integration-core`.

## 1. Check readiness

Call:

```http
GET /api/integration/stock-preparation/target/readiness?tenantId=<tenant>&projectId=<tenant>:integration-core
```

Expected not-yet-created shape:

```json
{
  "ok": true,
  "data": {
    "ready": false,
    "mode": "canonical_missing",
    "targetBinding": null,
    "evidence": {
      "status": "missing",
      "mode": "canonical_missing",
      "fieldMapMode": "canonical",
      "missingFields": ["... logical field ids only ..."]
    }
  }
}
```

## 2. Create or bind the canonical target

Call:

```http
POST /api/integration/stock-preparation/target/ensure
```

Body:

```json
{
  "tenantId": "<tenant>",
  "projectId": "<tenant>:integration-core",
  "baseId": "<optional-base-id>"
}
```

Successful create returns HTTP `201` and `mode: canonical_create`. Successful
bind of an existing complete canonical target returns HTTP `200` and
`mode: canonical_existing`.

## 3. Evidence rule

The response has two distinct sections:

- `data.targetBinding`: private admin config material. It may include
  `sheetId`. Do **not** paste this to issues/customer evidence.
- `data.evidence`: values-free readiness evidence. This is the only section
  allowed in #2253/customer evidence.

Allowed evidence fields:

- `status`
- `mode`
- `objectId`
- `fieldMapMode`
- `keyField`
- `fieldCounts`
- `missingFields`
- `optionSources`
- `target.fieldIdMapEmpty`

Forbidden evidence:

- `targetBinding`
- target sheet id
- physical field ids
- datasource ids
- credentials/tokens/connection strings
- PLM row values
- stock-preparation row values
- action config JSON

## 4. Fail-closed cases

- Non-admin user -> HTTP `403`; no provisioning call.
- Unsupported request fields such as `sheetId`, `fieldIdMap`, `target`,
  `source`, `permission`, `plan`, or `payload` -> HTTP `400`; no provisioning
  call.
- Existing canonical object with missing logical fields -> HTTP `422`
  `TARGET_SCHEMA_INCOMPLETE`; it is **not** repaired in place.

## 5. Pass condition for C1b-3

C1b-3 may start only when readiness evidence shows:

- `ready: true`
- `mode: canonical_create` or `canonical_existing`
- `evidence.status: ready`
- `evidence.missingFields: []`
- `evidence.target.fieldIdMapEmpty: true`

Full C5 smoke still also requires the separate PLM source gate: a real
`data-source:sql-readonly` PLM binding that satisfies the C2 flat-read contract.
