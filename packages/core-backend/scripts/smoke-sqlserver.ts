import { MSSQLAdapter } from '../src/data-adapters/MSSQLAdapter'
import type { ConfigValue, DataSourceConfig } from '../src/data-adapters/BaseAdapter'

const env = process.env

function printHelp(): void {
  console.log(`Usage: pnpm --filter @metasheet/core-backend smoke:sqlserver

Opt-in real-wire gate: with no MSSQL_HOST/MSSQL_SERVER set it SKIPS (exit 0), so it is safe in
normal CI. Configure a target to run it for real against a SQL Server.

Required environment:
  MSSQL_HOST or MSSQL_SERVER
  MSSQL_DATABASE
  MSSQL_USERNAME
  MSSQL_PASSWORD

Optional environment:
  MSSQL_PORT
  MSSQL_SCHEMA
  MSSQL_TABLE
  MSSQL_ENCRYPT
  MSSQL_TRUST_SERVER_CERTIFICATE
  MSSQL_CONNECTION_TIMEOUT_MS
  MSSQL_REQUEST_TIMEOUT_MS
  MSSQL_SKIP_SCHEMA`)
}

function required(name: string): string {
  const value = env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function optionalNumber(name: string): number | undefined {
  const value = env[name]
  if (value == null || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`)
  }
  return parsed
}

function optionalBoolean(name: string): boolean | undefined {
  const value = env[name]
  if (value == null || value.trim() === '') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${name} must be a boolean-like value`)
}

function putOptional(
  target: Record<string, ConfigValue>,
  name: string,
  value: ConfigValue | undefined
): void {
  if (value !== undefined) {
    target[name] = value
  }
}

function buildConfig(): DataSourceConfig {
  const connection: Record<string, ConfigValue> = {
    database: required('MSSQL_DATABASE')
  }

  putOptional(connection, 'host', env.MSSQL_HOST)
  putOptional(connection, 'server', env.MSSQL_SERVER)
  putOptional(connection, 'port', optionalNumber('MSSQL_PORT'))
  putOptional(connection, 'encrypt', optionalBoolean('MSSQL_ENCRYPT'))
  putOptional(connection, 'trustServerCertificate', optionalBoolean('MSSQL_TRUST_SERVER_CERTIFICATE'))
  putOptional(connection, 'connectionTimeoutMs', optionalNumber('MSSQL_CONNECTION_TIMEOUT_MS'))
  putOptional(connection, 'requestTimeoutMs', optionalNumber('MSSQL_REQUEST_TIMEOUT_MS'))

  return {
    id: 'sqlserver-smoke',
    name: 'SQL Server Smoke',
    type: 'sqlserver',
    connection,
    credentials: {
      username: required('MSSQL_USERNAME'),
      password: required('MSSQL_PASSWORD')
    },
    options: {
      readOnly: true,
      autoConnect: false
    }
  }
}

async function main(): Promise<void> {
  // Opt-in real-wire gate (B5A): skip cleanly (exit 0) when no SQL Server target is configured, so
  // this is safe in normal CI and on machines without a SQL Server. A target (MSSQL_HOST or
  // MSSQL_SERVER) present = opted in → run for real (a missing required var then fails loudly).
  if (!env.MSSQL_HOST && !env.MSSQL_SERVER) {
    console.log(
      '[skip] SQL Server smoke skipped — no MSSQL_HOST / MSSQL_SERVER set. This is an opt-in ' +
        'real-wire gate; export MSSQL_* (see docs/development/sqlserver-smoke-runbook-20260528.md) ' +
        'to run it against a real SQL Server. Exiting 0.'
    )
    return
  }
  const config = buildConfig()
  const schema = env.MSSQL_SCHEMA || 'dbo'
  const table = env.MSSQL_TABLE
  const skipSchema = optionalBoolean('MSSQL_SKIP_SCHEMA') === true

  const adapter = new MSSQLAdapter(config)

  console.log('[sqlserver-smoke] target', {
    host: config.connection.host,
    server: config.connection.server,
    port: config.connection.port,
    database: config.connection.database,
    encrypt: config.connection.encrypt ?? true,
    trustServerCertificate: config.connection.trustServerCertificate ?? true,
    schema,
    table: table || null
  })

  try {
    await adapter.connect()
    console.log('[ok] connected')

    const healthy = await adapter.testConnection()
    if (!healthy) {
      throw new Error('testConnection returned false')
    }
    console.log('[ok] testConnection SELECT 1')

    const one = await adapter.query<{ ok: number }>('SELECT $1 AS ok', [1])
    if (one.error) throw one.error
    if (one.data[0]?.ok !== 1) {
      throw new Error(`Unexpected SELECT result: ${JSON.stringify(one.data)}`)
    }
    console.log('[ok] parameterized query')

    if (!skipSchema) {
      const info = await adapter.getSchema(schema)
      console.log('[ok] schema introspection', {
        schema,
        tables: info.tables.length,
        views: info.views?.length ?? 0
      })
    }

    if (table) {
      const exists = await adapter.tableExists(table, schema)
      if (!exists) {
        throw new Error(`Table not found: ${schema}.${table}`)
      }
      console.log('[ok] table exists', `${schema}.${table}`)

      const tableInfo = await adapter.getTableInfo(table, schema)
      console.log('[ok] table info', {
        table: `${schema}.${table}`,
        columns: tableInfo.columns.length,
        primaryKey: tableInfo.primaryKey ?? []
      })

      // adapter.select() emits `FROM [table]` WITHOUT a schema, so it resolves against the login's
      // DEFAULT schema — not necessarily MSSQL_SCHEMA. Only run the select codegen probes when the
      // target is the default schema (dbo); otherwise they'd query the wrong table (false-fail, or
      // worse, silently sample a same-named table in the default schema). The metadata checks above
      // ARE schema-qualified, so they still run for any schema.
      if (schema === 'dbo') {
        const sample = await adapter.select(table, { limit: 5 })
        if (sample.error) throw sample.error
        console.log('[ok] select sample (TOP)', {
          table: `${schema}.${table}`,
          rows: sample.data.length
        })

        // Exercise the OFFSET/FETCH + ORDER BY branch as well (the TOP path above does not cover it).
        const orderColumn = tableInfo.primaryKey?.[0] ?? tableInfo.columns[0]?.name
        if (orderColumn) {
          const paged = await adapter.select(table, {
            limit: 3,
            offset: 1,
            orderBy: [{ column: orderColumn, direction: 'asc' }]
          })
          if (paged.error) throw paged.error
          console.log('[ok] select page (OFFSET/FETCH)', {
            table: `${schema}.${table}`,
            orderBy: orderColumn,
            rows: paged.data.length
          })
        }

        // A2 real-wire proof: a SCHEMA-QUALIFIED select exercises the per-segment quoting
        // ([schema].[table]) against the live engine — the bare-table probes above only cover the
        // single-segment [table] form. Connected to MSSQL_DATABASE, so [dbo].[<table>] resolves.
        const qualified = `${schema}.${table}`
        const qualifiedSample = await adapter.select(qualified, { limit: 1 })
        if (qualifiedSample.error) throw qualifiedSample.error
        console.log('[ok] select schema-qualified ([schema].[table])', {
          table: qualified,
          rows: qualifiedSample.data.length
        })
      } else {
        console.log(
          '[skip] select probes (TOP / OFFSET-FETCH) — adapter.select() is not schema-qualified; it ' +
            `queries the login default schema, not "${schema}". Use a dbo table (or MSSQL_SCHEMA=dbo) ` +
            `to cover the select codegen paths. (Metadata above WAS checked against "${schema}".)`
        )
      }
    }
  } finally {
    await adapter.disconnect().catch(error => {
      console.warn('[warn] disconnect failed', error)
    })
  }
}

if (process.argv.includes('--help')) {
  printHelp()
} else {
  main().catch(error => {
    console.error('[failed] SQL Server smoke failed')
    console.error(error)
    process.exitCode = 1
  })
}
