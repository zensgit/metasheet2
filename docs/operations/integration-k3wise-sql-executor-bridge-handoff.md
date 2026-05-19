# K3 WISE SQL Server Query Executor Bridge Handoff

## Purpose

This handoff is for the Windows/on-prem bridge machine that can reach the
customer K3 WISE SQL Server network.

MetaSheet ships the `erp:k3-wise-sqlserver` adapter contract and, as of the
2026-05-19 runtime slice, a built-in **read-only** SQL Server executor backed by
the packaged `mssql` dependency. The executor can test the configured SQL Server
connection and run structured `SELECT TOP <n>` reads against the adapter
allowlist. It does not accept raw SQL and does not enable SQL writes.

`SQLSERVER_EXECUTOR_MISSING` now means the packaged runtime wiring or dependency
install is broken, not that the normal package intentionally lacks SQL support.

Use `metasheet:staging` as the source for internal #1542 retests while this
handoff is still incomplete.

## Current Runtime Contract

The SQL channel is still created through the same injection seam:

```js
createK3WiseSqlServerChannelFactory({ queryExecutor })
```

The package runtime now registers the built-in read-only executor at activation:

```js
registerAdapter(
  'erp:k3-wise-sqlserver',
  createK3WiseSqlServerChannelFactory({ queryExecutor })
)
```

Deployment-owned custom executors may still replace this seam for customer
middle-table writes or a different driver, but ordinary read-only sampling no
longer requires a bridge-side source patch. Do not store a function in
`external_systems.config`; JSON config is for connection metadata, allowlists,
object maps, and middle-table policy only.

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

Built-in behavior:

- throws `SQLSERVER_WRITE_EXECUTOR_DISABLED`;
- keeps K3 SQL Server access read-only.

Custom deployment executor behavior, if explicitly supplied:

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

1. Deploy the current package with `deploy.bat` / the apply helper's default
   `InstallDeps=1`, or manually run `pnpm install --frozen-lockfile` from the
   deploy root. Upgrade installs must refresh dependencies even when
   `node_modules` already exists, because packages can add workspace runtime
   dependencies such as `mssql`.
2. Configure the SQL Server source with `server`, `database`, credentials, and
   read allowlist.
3. In Data Factory, test the `erp:k3-wise-sqlserver` source.
4. Confirm the system reports connected instead of `SQLSERVER_EXECUTOR_MISSING`
   or `SQLSERVER_DRIVER_MISSING`.
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
`code=SQLSERVER_EXECUTOR_MISSING`, the package wiring or dependency install is
incomplete. The staging-to-K3 path can remain signed off, but direct SQL Server
source execution is not ready.

If the code is `SQLSERVER_DRIVER_MISSING`, runtime injection is working but the
deploy root is missing `mssql`. Re-apply the package with `InstallDeps=1` or run
`pnpm install --frozen-lockfile` from the deploy root, restart PM2, then retest.

## What Claude Code Should Do On The Bridge Machine

Claude Code can help on the Windows/K3 bridge machine once it has local access
to the deployment and customer-approved credentials. The safe task is:

1. inspect the deployed package version and Node runtime;
2. verify `plugins/plugin-integration-core` installed its `mssql` dependency;
3. configure a read-only SQL account or readonly view/table allowlist;
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
- built-in `insertMany()` stays disabled unless a custom middle-table executor
  has been explicitly installed.
- Data Factory no longer disables the SQL source for
  `SQLSERVER_EXECUTOR_MISSING`.
- Postdeploy smoke records `sqlserver-executor-availability=pass`.
- Staging source retests still pass independently of SQL source execution.
