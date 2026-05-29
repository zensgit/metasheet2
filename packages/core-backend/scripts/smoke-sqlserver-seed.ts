// CI-only seed for the SQL Server real-wire smoke (B4 version-compat matrix).
//
// Creates `smoke_db.dbo.smoke_probe` (a tiny, isolated DB so the smoke's schema introspection stays
// clean and fast) so `smoke:sqlserver` can exercise tableExists / getTableInfo and BOTH select
// branches (TOP + OFFSET/FETCH) against a real engine — not only connect/SELECT.
//
// It uses the `mssql` driver DIRECTLY for the DDL/DML: the production MSSQLAdapter is read-only by
// design, so seeding does not go through it. Env-gated exactly like the smoke (skips with no target),
// and idempotent (drop-if-exists). The CI job runs it in a retry loop, so it doubles as the
// SQL-Server-readiness wait (a not-yet-started container just fails the connect and is retried).
const env = process.env

interface MssqlRequest {
  query(sql: string): Promise<unknown>
}
interface MssqlConnectionPool {
  connect(): Promise<MssqlConnectionPool>
  close(): Promise<void>
  request(): MssqlRequest
}
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown>) => MssqlConnectionPool
}

let mssql: MssqlModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mssql = require('mssql') as MssqlModule
} catch {
  // reported below if actually needed
}

async function main(): Promise<void> {
  if (!env.MSSQL_HOST && !env.MSSQL_SERVER) {
    console.log('[skip] seed skipped — no MSSQL_HOST / MSSQL_SERVER set (opt-in, CI-only).')
    return
  }
  if (!mssql) {
    throw new Error('mssql package is not installed')
  }

  const pool = new mssql.ConnectionPool({
    server: env.MSSQL_HOST || env.MSSQL_SERVER,
    port: env.MSSQL_PORT ? Number(env.MSSQL_PORT) : 1433,
    database: env.MSSQL_DATABASE || 'master',
    user: env.MSSQL_USERNAME,
    password: env.MSSQL_PASSWORD,
    options: {
      // CI containers use a self-signed cert; stay encrypted, skip cert identity.
      encrypt: env.MSSQL_ENCRYPT !== 'false',
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false'
    },
    connectionTimeout: 5000
  })

  await pool.connect()
  try {
    // CREATE DATABASE must run in its own batch.
    await pool.request().query("IF DB_ID('smoke_db') IS NULL CREATE DATABASE smoke_db;")
    // 3-part names so we never depend on the connection's current database.
    await pool.request().query(
      "IF OBJECT_ID('smoke_db.dbo.smoke_probe', 'U') IS NOT NULL DROP TABLE smoke_db.dbo.smoke_probe;" +
        ' CREATE TABLE smoke_db.dbo.smoke_probe (id INT NOT NULL PRIMARY KEY, name NVARCHAR(50) NULL);' +
        " INSERT INTO smoke_db.dbo.smoke_probe (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e');"
    )
    console.log('[ok] seeded smoke_db.dbo.smoke_probe (5 rows)')
  } finally {
    await pool.close()
  }
}

main().catch(error => {
  console.error('[failed] SQL Server seed failed')
  console.error(error)
  process.exitCode = 1
})
