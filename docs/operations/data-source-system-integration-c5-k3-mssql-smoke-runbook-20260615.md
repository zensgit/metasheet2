# Data Source System Integration C5 K3/MSSQL Smoke Runbook

Purpose: close the C5 real-wire gate after C5-2/C5-3/C5-4a have landed.

This runbook proves that the generic SQL Server data-source path and the K3 WISE SQL Server channel can both read from
the approved SQL Server environment without opening any K3 write surface.

## Scope

Allowed:

- generic `type=sqlserver` connect / schema introspection / bounded read smoke;
- `erp:k3-wise-sqlserver` channel `testConnection` and bounded read through the built-in read-only executor;
- values-free evidence with statuses, counts, configured object/table names, and TLS knob names.

Forbidden:

- K3 Save / Submit / Audit / BOM;
- external DB write;
- raw SQL input;
- credentials, connection strings, row values, raw SQL, K3 payloads, or stack traces in issue comments.

## Preconditions

- Deploy a package built from the C5-4a commit or newer.
- Use an operator-approved SQL Server environment.
- Use a read-only SQL login.
- Pick one small approved table for the K3 SQL Server bounded read.
- If testing a legacy SQL Server, decide the TLS knobs up front.

## Auth / Scope Triage

Use this section when the package is present and the smoke reaches SQL Server, but the result is still
`login_failed`, `sqlserver_test_failed`, or `SQLSERVER_TEST_FAILED`.

This is an operator-side SQL scope check, not a code/package check. Do not repeat the smoke under an unchanged SQL
scope and treat the repeated failure as new evidence; it is expected to reproduce the same result.

Confirm or adjust the approved read-only scope before the next PASS attempt:

- The configured SQL login can authenticate to the intended SQL Server under the same legacy TLS settings used by the
  smoke.
- The configured database is the intended smoke database, not a default, empty, or no-permission database.
- The configured object exists in that database. Include the schema when the object is not under the default schema.
- The configured SQL login has read-only access to the configured object.
- The K3 executor smoke uses an equivalent approved read-only database and object scope.

Use least-privilege grants only. The exact SQL depends on the customer's SQL Server security model, but the shape should
stay read-only:

```sql
-- Example shape only. Replace placeholders on the SQL Server side; do not paste real values into issues.
GRANT CONNECT ON DATABASE::<database_name> TO <read_only_user>;
GRANT SELECT ON OBJECT::<schema_name>.<object_name> TO <read_only_user>;
```

If schema or table metadata remains invisible after `SELECT` is granted, confirm metadata visibility for the same
read-only object scope. Do not grant broad admin, owner, or write permissions just to satisfy the smoke.

Values-free evidence to report after scope confirmation:

- `sqlScopeConfirmed=true`;
- `loginCanAuthenticate=true|false`;
- `databaseScopeConfirmed=true|false`;
- `objectExists=true|false`;
- `objectReadPermission=true|false`;
- `k3ReadScopeConfirmed=true|false`.

Do not report usernames, passwords, hostnames, database names, connection strings, SQL text with real identifiers, row
values, or stack traces.

## Generic SQL Server Smoke

Run from the deploy root:

```bash
export MSSQL_SERVER='<configured server or host, optionally with port>'
export MSSQL_DATABASE='<database>'
export MSSQL_USERNAME='<read-only user>'
export MSSQL_PASSWORD='<password>'
export MSSQL_SCHEMA='<schema>'
export MSSQL_TABLE='<small approved table>'

# Optional legacy TLS knobs, only when needed:
# export MSSQL_LEGACY_TLS='true'
# export MSSQL_TLS_MIN_VERSION='TLSv1'
# export MSSQL_TLS_CIPHERS='DEFAULT@SECLEVEL=0'

pnpm --filter @metasheet/core-backend smoke:sqlserver
```

Evidence to report:

- `genericSqlserver.status=pass|fail`;
- `genericSqlserver.connected=true|false`;
- `genericSqlserver.schemaIntrospection=pass|fail|skipped`;
- `genericSqlserver.tableInfo=pass|fail|skipped`;
- `genericSqlserver.select=pass|fail|skipped`;
- `genericSqlserver.legacyTls=true|false`;
- `genericSqlserver.tlsMinVersion=<name|null>`;
- `genericSqlserver.tlsCiphersConfigured=true|false`.

Do not paste the raw target line if it contains host, database, or other environment-specific values. Convert it to the
values-free fields above.

## K3 SQL Server Smoke

Run from the deploy root:

```bash
export K3_MSSQL_SERVER="$MSSQL_SERVER"
export K3_MSSQL_DATABASE="$MSSQL_DATABASE"
export K3_MSSQL_USERNAME="$MSSQL_USERNAME"
export K3_MSSQL_PASSWORD="$MSSQL_PASSWORD"
export K3_MSSQL_TABLE='<operator-approved K3/read-only table>'
export K3_MSSQL_LIMIT='1'

# Optional. Use only configured field names, never values:
# export K3_MSSQL_COLUMNS='FItemID,FNumber'
# export K3_MSSQL_ORDER_BY='FNumber'

# Optional legacy TLS knobs, matching the generic smoke when needed:
# export K3_MSSQL_LEGACY_TLS="$MSSQL_LEGACY_TLS"
# export K3_MSSQL_TLS_MIN_VERSION="$MSSQL_TLS_MIN_VERSION"
# export K3_MSSQL_TLS_CIPHERS="$MSSQL_TLS_CIPHERS"

pnpm --filter plugin-integration-core smoke:k3-sqlserver-executor
```

Evidence to report:

- `k3Sqlserver.status=pass|fail`;
- `k3Sqlserver.testConnection=pass|fail`;
- `k3Sqlserver.read=pass|fail`;
- `k3Sqlserver.rows=<count>`;
- `k3Sqlserver.table=<operator-configured table/object name>`;
- `k3Sqlserver.columns=<count|null>`;
- `k3Sqlserver.legacyTls=true|false`;
- `k3Sqlserver.tlsMinVersion=<name|null>`;
- `k3Sqlserver.tlsCiphersConfigured=true|false`.

If the K3 smoke fails, report the public error code printed by the script. Do not paste raw driver messages, stack
traces, hostnames, connection strings, SQL text, or row values.

## Issue Reply Template

```text
C5 K3/MSSQL real-wire smoke

packageFingerprint=<short commit/package fingerprint>
releaseAssetCheck=pass|fail
deploy.applyExit=<code>
health=200|...

genericSqlserver:
  status=pass|fail
  connected=true|false
  schemaIntrospection=pass|fail|skipped
  tableInfo=pass|fail|skipped
  select=pass|fail|skipped
  legacyTls=true|false
  tlsMinVersion=<name|null>
  tlsCiphersConfigured=true|false

k3Sqlserver:
  status=pass|fail
  testConnection=pass|fail
  read=pass|fail
  rows=<count>
  table=<operator-configured table/object name>
  columns=<count|null>
  legacyTls=true|false
  tlsMinVersion=<name|null>
  tlsCiphersConfigured=true|false

boundaries:
  k3Save=false
  k3Submit=false
  k3Audit=false
  k3BomWrite=false
  externalDbWrite=false
  rawSql=false
  valuesFreeEvidence=true

operatorDecision=pass|hold
```

## Pass Criteria

- Both generic and K3 SQL Server smoke pass.
- Evidence is values-free.
- No write boundary is crossed.
- If legacy TLS is used, the evidence states which knobs were active by name/boolean only.

Passing this runbook closes C5. It does not open C6 external write; C6 remains a separate design-first gate.
