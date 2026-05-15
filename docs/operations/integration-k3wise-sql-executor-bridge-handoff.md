# K3 WISE SQL Server Query Executor Bridge Handoff

## Purpose

This handoff is for the Windows/on-prem bridge machine that can reach the
customer K3 WISE SQL Server network.

MetaSheet already ships the `erp:k3-wise-sqlserver` adapter contract. The
default package intentionally does not ship a production SQL Server driver or
open database connection. Until the bridge deployment injects an allowlisted
`queryExecutor`, Data Factory will show `SQLSERVER_EXECUTOR_MISSING` and direct
SQL Server source execution must stay disabled.

Use `metasheet:staging` as the source for internal #1542 retests while this
handoff is still incomplete.

## Current Runtime Contract

The SQL channel is created by:

```js
createK3WiseSqlServerChannelFactory({ queryExecutor })
```

The default plugin registration currently has no executor:

```js
registerAdapter('erp:k3-wise-sqlserver', createK3WiseSqlServerChannelFactory())
```

That means the bridge layer must own the executor wiring. Do not store a
function in `external_systems.config`; JSON config is for connection metadata,
allowlists, object maps, and middle-table policy only.

## Executor Interface

The injected executor must expose these methods.

### `testConnection({ system, input })`

Expected behavior:

- verify SQL Server reachability and credential validity;
- return `undefined`, `{ ok: true }`, or an object whose `ok` is not `false`;
- never return raw credentials, DSNs, passwords, or connection strings.

Failure behavior:

- throw an error or return `{ ok: false }`;
- use clear deployment-facing messages, not secrets.

### `select({ table, columns, limit, cursor, filters, watermark, orderBy, options, system })`

Expected behavior:

- execute read-only queries for tables or views already allowed by
  `system.config.allowedTables.read`;
- build SQL with parameterized values;
- map structured filters instead of accepting user-written SQL;
- return either an array of records or:

```js
{
  records: [],
  nextCursor: null,
  done: true
}
```

Hard constraints:

- no `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `ALTER`, `DROP`, or
  `CREATE`;
- no dynamic table names beyond the adapter-provided `table`;
- no raw SQL input from UI, pipeline options, or customer JSON.

### `insertMany({ table, records, keyFields, mode, options, system })`

Expected behavior:

- write only to allowlisted middle tables from `system.config.allowedTables.write`;
- use parameterized inserts or controlled stored procedures;
- return:

```js
{
  written: 0,
  failed: 0,
  errors: [],
  results: []
}
```

Hard constraints:

- never write directly to K3 core tables such as `t_ICItem`, `t_ICBOM`,
  `t_ICBomChild`, `t_MeasureUnit`, or `t_Organization`;
- never enable Submit/Audit through the SQL channel;
- keep Save-only / WebAPI workflow decisions outside the SQL executor.

## System Config Expectations

A SQL source system should remain ordinary JSON metadata:

```json
{
  "kind": "erp:k3-wise-sqlserver",
  "role": "source",
  "status": "active",
  "config": {
    "mode": "readonly",
    "allowedTables": {
      "read": ["dbo.v_MetaSheet_MaterialRead", "dbo.v_MetaSheet_BomRead"],
      "write": ["dbo.integration_material_stage"]
    },
    "objects": {
      "material": {
        "table": "dbo.v_MetaSheet_MaterialRead",
        "operations": ["read"],
        "keyField": "FNumber"
      }
    }
  }
}
```

Connection secrets belong in the deployment secret store, environment variables,
or bridge-side secret manager. They do not belong in tracked JSON examples,
Data Factory previews, smoke artifacts, or `external_systems.config`.

## Operator Verification Flow

1. Deploy the bridge-side executor on a machine that can reach SQL Server.
2. Inject it into `createK3WiseSqlServerChannelFactory({ queryExecutor })`.
3. In Data Factory, test the `erp:k3-wise-sqlserver` source.
4. Confirm the system no longer reports `SQLSERVER_EXECUTOR_MISSING`.
5. Run the postdeploy smoke:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke
```

Expected smoke result after executor wiring:

- `signoff.internalTrial=pass`;
- `summary.fail=0`;
- `sqlserver-executor-availability.status=pass` when a SQL source is configured.

If `sqlserver-executor-availability.status=skipped` with
`code=SQLSERVER_EXECUTOR_MISSING`, the bridge wiring is still incomplete. The
staging-to-K3 path can remain signed off, but direct SQL Server source execution
is not ready.

## What Claude Code Should Do On The Bridge Machine

Claude Code can help on the Windows/K3 bridge machine once it has local access
to the deployment and customer-approved credentials. The safe task is:

1. inspect the deployed package version and Node runtime;
2. locate the deployment-owned adapter registration/wiring point;
3. implement an allowlisted `queryExecutor` module outside customer secrets;
4. run connection tests against a test account or readonly view;
5. rerun the postdeploy smoke and capture redacted evidence.

Claude Code should not:

- paste credentials into chat;
- write SQL credentials into Git;
- enable direct writes to K3 core tables;
- turn on Submit/Audit before customer GATE approval.

## Acceptance Checklist

- `testConnection()` passes without leaking secrets.
- `select()` can read the approved readonly view/table for the configured
  object.
- `insertMany()` is either disabled or limited to approved middle tables.
- Data Factory no longer disables the SQL source for
  `SQLSERVER_EXECUTOR_MISSING`.
- Postdeploy smoke records `sqlserver-executor-availability=pass`.
- Staging source retests still pass independently of SQL source execution.
