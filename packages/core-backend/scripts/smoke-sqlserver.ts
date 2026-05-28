import { MSSQLAdapter } from '../src/data-adapters/MSSQLAdapter'
import type { ConfigValue, DataSourceConfig } from '../src/data-adapters/BaseAdapter'

const env = process.env

function printHelp(): void {
  console.log(`Usage: pnpm --filter @metasheet/core-backend smoke:sqlserver

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

      const sample = await adapter.select(table, { limit: 5 })
      if (sample.error) throw sample.error
      console.log('[ok] select sample', {
        table: `${schema}.${table}`,
        rows: sample.data.length
      })
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
