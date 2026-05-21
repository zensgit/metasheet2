# Data Factory Legacy SQL Readonly Bridge Agent Plan - 2026-05-20

## Summary

This plan changes the SQL Server 2014 RTM / older-SQL path from "MetaSheet
connects directly to the legacy database" to "MetaSheet talks to a customer-side
readonly Bridge Agent over HTTP/JSON".

The goal is to keep Data Factory able to fetch latest data on demand without
manual export or scheduled file export, while avoiding fragile direct driver
compatibility work inside the MetaSheet main runtime.

The Bridge Agent is deployed on the machine that can reliably reach the customer
legacy SQL database. If the MetaSheet on-prem Windows server can reach that
database and can use the required legacy driver, the Bridge Agent can run on the
same server and listen on localhost only.

## Decision

Do not make the MetaSheet Node.js backend directly support SQL Server 2000 /
2005 / 2008 / SQL Server 2014 RTM legacy protocol combinations.

Instead:

- MetaSheet supports a stable `readonly bridge` HTTP/JSON protocol.
- The customer-side Bridge Agent handles legacy driver compatibility.
- The Bridge Agent is readonly, allowlist-bound, and does not expose raw SQL.
- Data fetched through the Bridge Agent lands in Data Factory staging
  multitables for cleansing, validation, dry-run, and later K3 WISE Save-only.

### Customer off-ramp: SQL Server 2014 in-place patch to SP2/SP3

If a specific customer is willing and able to apply an in-place SQL Server
2014 RTM → SP2/SP3 update on their PLM database (free Microsoft service pack)
and to confirm TLS 1.2 negotiation against a modern client driver from the
MetaSheet on-prem server, then this Bridge Agent plan **does not need to be
implemented for that customer**: MetaSheet's existing Node.js `mssql`-based
SQL adapter path applies as-is, and the legacy pre-login / TLS / protocol
negotiation failure observed in the entity-environment evidence on
`12.0.2000.8` (SQL Server 2014 RTM) goes away.

This off-ramp does **not** void the Bridge Agent plan as a generalizable
direction. It only documents the explicit out-clause for customers whose
DBA team can patch the legacy SQL Server itself, so that we do not
over-engineer a customer-side service when an in-place service pack
resolves the same issue at lower operational cost. For customers who
cannot or will not patch the legacy SQL Server, the Bridge Agent path
remains the recommended main route.

## Why This Is Needed

Issue #1710 confirmed the current customer database is SQL Server 2014 RTM
(`12.0.2000.8`) and cannot be upgraded. It also confirmed:

- TCP can reach the SQL Server port.
- MetaSheet's allowlist/schema layer works for configured objects.
- Unconfigured objects are blocked.
- Modern client paths fail before query execution during pre-login / protocol
  negotiation.
- The customer still needs latest data at operation time; manual export and
  fixed scheduled export are not acceptable as the final integration mode.

The Bridge Agent isolates the old database protocol problem from the MetaSheet
main runtime while preserving a live, on-demand data path.

## Target Architecture

### Same-machine deployment

Use this when the MetaSheet on-prem Windows server can reach the legacy SQL
Server and can run the customer-approved SQL driver.

```text
Windows MetaSheet Server
  - MetaSheet backend/frontend
  - Readonly Bridge Agent, listening on 127.0.0.1:19091
  - customer-approved SQL driver
        |
        v
Legacy SQL Server / PLM DB
```

MetaSheet config points to:

```text
http://127.0.0.1:19091
```

### Separate bridge-machine deployment

Use this when only a customer bridge machine can reach the database or install
the legacy driver.

```text
MetaSheet Server
        |
        | HTTPS or restricted internal HTTP
        v
Customer Bridge Machine
  - Readonly Bridge Agent
  - customer-approved SQL driver
        |
        v
Legacy SQL Server / PLM DB
```

The Bridge Agent port must be restricted to the MetaSheet server by firewall,
IP allowlist, shared secret, or mTLS depending on the customer environment.

## Supported Database Position

MetaSheet core support:

- Standard HTTP/JSON Bridge protocol.
- Data Factory source integration over that protocol.
- Staging multitable cleansing and dry-run.

Bridge Agent compatibility target:

- SQL Server 2014 RTM.
- SQL Server 2012.
- SQL Server 2008 / 2008 R2.
- SQL Server 2005.
- SQL Server 2000, when the customer has a working local driver.

Important wording:

- MetaSheet does not promise direct Node.js driver support for SQL Server
  2000/2005/2008/2014 RTM.
- The Bridge Agent can support those databases when the customer provides a
  driver/runtime that works on the bridge machine.

## Open-source Reference Survey

The Bridge Agent should borrow proven ideas from existing projects, but should
not embed a broad data platform into the customer bridge path.

### Candidate references

| Project | What to borrow | Why not adopt wholesale |
| --- | --- | --- |
| jTDS | Legacy SQL Server JDBC compatibility for SQL Server 2000/2005/2008-era deployments. | The project is old; use only when customer IT accepts the driver and the bridge machine validates it. |
| Apache Camel | Route structure, JDBC-to-HTTP bridge shape, error handling, and deployment patterns. | Camel can expose dynamic routes and SQL-like flexibility; the MetaSheet bridge must keep fixed allowlisted endpoints only. |
| Spring Boot | Small Windows-friendly HTTP service packaging, health endpoint, config, and service lifecycle. | The bridge still needs custom allowlist, redaction, and no-raw-SQL constraints. |
| .NET Framework / System.Data | Windows-native compatibility with old SQL Server drivers already installed in customer environments. | This is runtime-specific; choose it only when the customer confirms the driver stack. |
| DreamFactory / Hasura / Teiid / NiFi | API governance, connector UX, and data virtualization concepts. | Too broad for this PoC; these platforms risk exposing query/schema surfaces wider than the fixed readonly bridge needs. |

### Recommended MVP technology paths

Pick one after customer bridge-machine confirmation:

1. **Java + jTDS + Spring Boot**
   - Best when the customer accepts JVM deployment and jTDS is the only driver
     that can connect to the legacy SQL Server.
   - Use fixed controller methods, not dynamic SQL routes.

2. **Apache Camel + fixed SQL routes**
   - Useful if the team wants a declarative integration route and JDBC
     component lifecycle.
   - Lock routes to `material`, `bom`, and `bom_child`; do not expose Camel as a
     general integration workbench.

3. **.NET Framework Windows service**
   - Best when customer IT already proves SQL Native Client, ODBC, OLE DB, or
     `System.Data.SqlClient` can connect from the bridge machine.
   - Often the most practical path for SQL Server 2000/2005/2008-era customer
     sites.

### Explicit non-goals

- Do not ship DreamFactory/Hasura/Teiid/NiFi as the default bridge runtime.
- Do not expose a generic SQL console.
- Do not add a generalized data virtualization server to the customer path.
- Do not make MetaSheet's main Node.js backend depend on legacy SQL drivers.

## Security Model

Hard constraints:

- Readonly only.
- No raw SQL from UI, API request, pipeline config, or customer JSON.
- Only allowlisted objects can be queried.
- Each object maps to a fixed SQL template or fixed stored read shape.
- Row limit is mandatory.
- Credentials stay on the bridge machine.
- Credentials must not be stored in Git, issue comments, PR bodies, Data Factory
  previews, smoke artifacts, or logs.
- Bridge Agent must redact secrets from errors.
- Bridge Agent must default to localhost-only when deployed on the MetaSheet
  server.
- K3 Save / Submit / Audit is out of scope.
- SQL writes are out of scope.

Recommended network controls:

- Same-machine mode: bind to `127.0.0.1`.
- Separate-machine mode: restrict source IP to the MetaSheet server.
- Add a shared secret header or mTLS before any non-localhost deployment.
- Keep request/response logs metadata-only by default.

## Data Scope V1

V1 supports only the first K3/PLM PoC objects:

| Object | Legacy SQL source | Purpose |
| --- | --- | --- |
| `material` | `t_ICItem` or customer readonly view | Material master staging |
| `bom` | `t_ICBOM` or customer readonly view | BOM header staging |
| `bom_child` | `t_ICBomChild` or customer readonly view | BOM component staging |

Preferred customer setup is readonly views:

```text
v_MetaSheet_MaterialRead
v_MetaSheet_BomRead
v_MetaSheet_BomChildRead
```

Direct core-table reads can be allowed for the PoC only when the SQL account is
readonly and the customer explicitly approves the allowlist.

## Bridge Agent API V1

### `GET /health`

Purpose:

- Confirm the Bridge Agent process is alive.
- Optionally perform a lightweight database connectivity check.

Response:

```json
{
  "ok": true,
  "service": "metasheet-legacy-sql-readonly-bridge",
  "version": "0.1.0",
  "databaseReachable": true
}
```

### `GET /objects`

Purpose:

- Return the configured allowlisted objects.

Response:

```json
{
  "objects": [
    { "id": "material", "label": "Material", "readonly": true },
    { "id": "bom", "label": "BOM Header", "readonly": true },
    { "id": "bom_child", "label": "BOM Child", "readonly": true }
  ]
}
```

### `GET /schema/:object`

Purpose:

- Return the safe field schema for an allowlisted object.

Example response:

```json
{
  "object": "material",
  "fields": [
    { "name": "FItemID", "type": "number", "required": false },
    { "name": "FNumber", "type": "string", "required": true },
    { "name": "FName", "type": "string", "required": true },
    { "name": "FModel", "type": "string", "required": false }
  ]
}
```

### `POST /query/:object`

Purpose:

- Fetch latest allowlisted rows on demand.
- Used by Data Factory "refresh source data" or "sample latest rows".

Request:

```json
{
  "limit": 3,
  "filters": {},
  "watermark": null
}
```

Response:

```json
{
  "object": "material",
  "records": [],
  "nextCursor": null,
  "done": true
}
```

Rules:

- `limit` defaults to `3` for sample and must have a hard maximum.
- `object` must be allowlisted.
- `filters` must be structured key/value filters only.
- No raw SQL is accepted.
- Query templates are controlled by the Bridge Agent config.

## Bridge Agent Config Shape

Example only; do not commit real values.

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 19091
  },
  "auth": {
    "mode": "shared-secret-header"
  },
  "database": {
    "driver": "customer-approved-driver",
    "server": "<configured-on-bridge-machine>",
    "database": "<configured-on-bridge-machine>",
    "credentialRef": "<local-secret-ref>"
  },
  "objects": {
    "material": {
      "source": "t_ICItem",
      "keyField": "FNumber",
      "columns": ["FItemID", "FNumber", "FName", "FModel"]
    },
    "bom": {
      "source": "t_ICBOM",
      "keyField": "FBOMInterID",
      "columns": ["FBOMInterID", "FBOMNumber", "FItemID"]
    },
    "bom_child": {
      "source": "t_ICBomChild",
      "keyField": "FBOMInterID",
      "columns": ["FBOMInterID", "FItemID", "FQty"]
    }
  },
  "limits": {
    "sampleLimit": 3,
    "maxLimit": 100
  }
}
```

## Implementation TODO

### BA-M0 - Contract and customer confirmation

- [ ] Update #1710 with Bridge Agent direction.
- [ ] Confirm whether the Bridge Agent runs on the MetaSheet on-prem server or
      a separate customer bridge machine.
- [ ] Confirm the preferred implementation path:
      - Java + jTDS + Spring Boot;
      - Apache Camel + fixed JDBC routes;
      - .NET Framework Windows service;
      - another customer-approved runtime.
- [ ] Confirm which customer-approved driver can connect to the legacy SQL
      Server from that machine.
- [ ] Confirm readonly account or local secret storage pattern.
- [ ] Confirm object allowlist and field allowlist.
- [ ] Confirm sample row limit and later full-refresh limit.
- [ ] **Required maintainer decision before BA-M1**: does MetaSheet package
      and distribute the Bridge Agent (signed, versioned, included in the
      `metasheet-multitable-onprem` package, with verify-script gate), or is
      it a separately delivered customer-side utility where MetaSheet
      publishes the protocol/contract spec and customers build/own the
      agent? The two answers differ by roughly 3-5× in implementation and
      ongoing-support effort, and shape BA-M1's work-item structure.

### BA-M0.5 - Driver smoke spike (gate before BA-M1)

Before BA-M1 implementation starts, prove that the runtime/driver the customer
chose in BA-M0 can actually negotiate with their real SQL Server endpoint.
Without this step, the failure mode is: write the full Bridge Agent MVP,
ship it, and only discover at V3 (customer bridge-machine smoke) that the
chosen driver cannot connect — a 1-2 week rework instead of a 1-hour spike.

- [ ] On the chosen bridge machine (same as the eventual Bridge Agent host),
      write a minimal harness in the chosen runtime: ≤50 lines of console
      app / PowerShell script / shell script.
- [ ] The harness opens a single connection to the customer's real legacy
      SQL Server endpoint using the customer-approved driver.
- [ ] The harness runs exactly one read-only query, e.g.
      `SELECT @@VERSION` or `SELECT TOP 1 1`.
- [ ] The harness exits with a non-zero status on connection failure or
      query failure.
- [ ] Capture redacted output: driver name + driver version + SQL Server
      `@@VERSION` echo. No credentials, no connection string, no row data.

Pass criteria:

- Harness exits 0.
- `@@VERSION` (or equivalent) is returned and matches the expected SQL
  Server 2014 RTM (`12.0.2000.8`) or whichever legacy version the customer
  confirmed.

Stop and re-decide if:

- The chosen driver cannot pre-login / cannot complete TLS / cannot
  authenticate against the legacy SQL Server.
- The customer's SQL account cannot read the agreed allowlist objects.
- The harness output contains anything secret-shaped (credentials,
  connection strings, JWT-shape tokens).

Output of this step:

- A redacted `BA-M0.5-driver-smoke.{json,md}` evidence pair, kept outside
  Git, suitable for review by a maintainer before unblocking BA-M1.
- **BA-M1 does not start until BA-M0.5 is signed off green.**

### BA-M1 - Bridge Agent MVP

- [ ] Create a standalone Bridge Agent package outside the MetaSheet main
      backend runtime.
- [ ] Implement local config loading with secret values outside Git.
- [ ] Implement driver provider interface:
      - `testConnection()`
      - `getSchema(object)`
      - `query(object, request)`
- [ ] Implement `GET /health`.
- [ ] Implement `GET /objects`.
- [ ] Implement `GET /schema/:object`.
- [ ] Implement `POST /query/:object`.
- [ ] Enforce object allowlist.
- [ ] Enforce column allowlist.
- [ ] Enforce limit cap.
- [ ] Reject raw SQL and unknown filters.
- [ ] Redact errors before returning or logging.
- [ ] Bind to `127.0.0.1` by default.

Implementation note:

- For SQL Server 2000/2005/2008/2014 RTM compatibility, a Windows-native
  implementation using customer-approved ODBC/OLE DB/SQL Native Client or .NET
  Framework `System.Data.*` may be more reliable than Node.js `mssql`.
- For Java-based compatibility, jTDS is the main legacy-driver candidate to
  test first, provided customer IT accepts the driver and validates it on the
  bridge machine.
- Apache Camel can be used as a route engine only if the route surface stays
  fixed and allowlisted. It must not become a raw SQL/query builder path.
- The Bridge Agent protocol is more important than the first implementation
  language. MetaSheet should consume HTTP/JSON either way.

### BA-M2 - MetaSheet Data Factory integration

- [ ] Add a Bridge HTTP source adapter or configure this through the existing
      HTTP source path with a locked preset.
- [ ] Add connector kind, for example `bridge:legacy-sql-readonly`.
- [ ] Add connection test:
      - call `/health`;
      - call `/objects`;
      - do not touch SQL directly from MetaSheet.
- [ ] Add schema discovery:
      - call `/schema/:object`;
      - map fields to Data Factory dataset schema.
- [ ] Add sample preview:
      - call `/query/:object` with `limit <= 3`.
- [ ] Add source refresh:
      - fetch rows;
      - write into staging multitable;
      - record import summary.
- [ ] Keep dry-run as the next step before K3 write.
- [ ] Keep K3 Save / Submit / Audit disabled by default.

### BA-M3 - Data Factory UI

- [ ] Add "Readonly Bridge Source" as an advanced source option.
- [ ] Explain that this is for legacy customer databases accessed through a
      customer-side bridge service.
- [ ] Show Bridge Agent base URL.
- [ ] Show health/test status.
- [ ] Show allowlisted objects only.
- [ ] Show schema preview.
- [ ] Show sample preview with row cap.
- [ ] Add "Refresh latest source data" action.
- [ ] Route imported rows to staging multitable.
- [ ] Never show raw credentials or SQL connection strings.

### BA-M4 - Operations and packaging

- [ ] Add operations runbook for Bridge Agent deployment.
- [ ] Document same-machine localhost deployment.
- [ ] Document separate bridge-machine deployment.
- [ ] Document firewall/IP allowlist/shared-secret controls.
- [ ] Document Windows service or scheduled process management.
- [ ] Document log redaction.
- [ ] Document backup/rollback.
- [ ] Decide whether the Bridge Agent is shipped inside the MetaSheet on-prem
      package or distributed as a separate customer-side utility.

Recommended initial packaging:

- Keep Bridge Agent as a separate utility until the first customer PoC proves
  the driver/runtime choice.
- Do not put customer-specific legacy drivers inside the main MetaSheet package.

### BA-M5 - Post-GATE runtime closeout

- [ ] Use the Bridge Agent to fetch Material sample rows.
- [ ] Use the Bridge Agent to fetch BOM header sample rows.
- [ ] Use the Bridge Agent to fetch BOM child sample rows.
- [ ] Import rows into staging multitables.
- [ ] Cleanse and validate in Data Factory.
- [ ] Generate K3 payload preview.
- [ ] Run dry-run.
- [ ] Only after customer approval, execute Save-only for 1-3 rows.
- [ ] Keep Submit/Audit disabled.

## Verification Plan

### V0 - Static review

- [ ] No raw SQL entrypoint exists in UI or API.
- [ ] Object allowlist is required.
- [ ] Column allowlist is required.
- [ ] Limit cap is required.
- [ ] Credentials are not in tracked config examples.
- [ ] Logs redact secret-shaped values.

### V1 - Bridge Agent unit tests

- [ ] `/health` returns OK without exposing config secrets.
- [ ] `/objects` returns only configured objects.
- [ ] `/schema/material` returns configured fields.
- [ ] `/schema/unknown` returns a safe unsupported-object error.
- [ ] `/query/material` calls the driver provider with the configured source.
- [ ] `/query/unknown` is blocked.
- [ ] limit above maximum is capped or rejected.
- [ ] raw SQL-like input is rejected.
- [ ] driver errors are redacted.

### V2 - Fake legacy driver tests

Use a fake driver provider before touching the customer database.

- [ ] Fake driver connection success.
- [ ] Fake driver connection failure.
- [ ] Fake material rows.
- [ ] Fake BOM rows.
- [ ] Fake BOM child rows.
- [ ] Error redaction.
- [ ] No write methods exposed.

### V3 - Customer bridge-machine smoke

Run on the machine that can reach the legacy SQL Server.

- [ ] Driver can connect using customer-approved settings.
- [ ] Bridge Agent starts and binds to the expected interface.
- [ ] `/health` returns OK.
- [ ] `/objects` returns only allowlisted objects.
- [ ] `/schema/material` returns safe schema.
- [ ] `/query/material` returns at most 1-3 rows.
- [ ] `/query/bom` returns at most 1-3 rows.
- [ ] `/query/bom_child` returns at most 1-3 rows.
- [ ] No credentials appear in stdout/stderr/log files.

### V4 - MetaSheet integration smoke

- [ ] Data Factory connection test calls Bridge Agent health.
- [ ] Data Factory object list matches Bridge Agent allowlist.
- [ ] Schema discovery works for Material/BOM/BOM child.
- [ ] Sample preview works with row cap.
- [ ] Imported sample rows land in staging multitables.
- [ ] Required-field validation still works in staging multitable.
- [ ] Dry-run can use imported rows.
- [ ] K3 payload preview remains secret-free.

### V5 - Negative tests

- [ ] Bridge Agent unreachable returns clear UI error.
- [ ] Invalid shared secret is rejected.
- [ ] Unknown object is rejected.
- [ ] Non-allowlisted source is rejected.
- [ ] raw SQL input is rejected.
- [ ] excessive limit is capped or rejected.
- [ ] driver error is redacted.
- [ ] K3 Save / Submit / Audit cannot be triggered from Bridge Agent actions.

### V6 - Entity-machine acceptance

Acceptance for the first customer run:

- [ ] The Bridge Agent is reachable from MetaSheet.
- [ ] The Bridge Agent can query latest Material/BOM data on demand.
- [ ] Sample size is capped at 1-3 rows for evidence.
- [ ] Evidence is redacted before posting to issues/PRs.
- [ ] Data lands in staging multitable.
- [ ] Data Factory cleansing and dry-run work.
- [ ] No SQL writes occurred.
- [ ] No K3 Save / Submit / Audit occurred unless explicitly approved.

## Customer IT Checklist

Customer IT should provide or confirm:

- [ ] Bridge deployment machine.
- [ ] Whether Bridge Agent can run on the MetaSheet server.
- [ ] SQL Server host and port, shared only through the secure deployment
      channel.
- [ ] Database name, shared only through the secure deployment channel.
- [ ] Readonly account or service account.
- [ ] Driver/runtime that can connect from the bridge machine.
- [ ] Whether the driver is ODBC, OLE DB, SQL Native Client, .NET Framework,
      JDBC, or another approved path.
- [ ] Object allowlist.
- [ ] Field allowlist.
- [ ] Row limit policy.
- [ ] Whether readonly views can be provided instead of direct core-table reads.

## Open Questions

- [ ] Should the first Bridge Agent implementation be a Windows service,
      console app, or managed scheduled process?
- [ ] Which runtime is acceptable for the customer: .NET Framework, .NET,
      PowerShell-hosted .NET, Java/JDBC, or another customer-approved stack?
- [ ] Does the customer require mTLS for non-localhost Bridge Agent access?
- [ ] What is the maximum safe row count for non-sample refresh after the first
      PoC?
- [ ] Should full refresh overwrite staging rows or upsert by business key?

## Recommended Issue Handling

- Keep #1710 open.
- Change the implementation direction from direct SQL Server sampling to
  customer-side readonly Bridge Agent.
- Keep #1709 and #1711 as separate post-GATE runtime issues.
- Do not begin K3 Save / Submit / Audit work until customer GATE explicitly
  approves a small Save-only test.

## Stop Rules

Stop and do not proceed if any of these occur:

- Customer cannot provide a working bridge-machine driver.
- Only a writable SQL account is available.
- Customer asks for raw SQL editor access.
- Customer asks to expose Bridge Agent publicly without access controls.
- Query evidence contains credentials or connection strings.
- The bridge path requires lowering MetaSheet main runtime security.
- K3 Submit/Audit is requested before GATE approval.
