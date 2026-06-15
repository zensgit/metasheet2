// Generic SQL Server data-source adapter (Lane B). Driver: `mssql` (^10),
// aligned with plugin-integration-core. Modern servers connect securely by
// default; a legacy SQL Server (2008R2/2012) that cannot negotiate modern TLS
// can opt down PER-SOURCE via the B3 lever (buildLegacyTlsOptions) — scoped to
// this one connection, the customer's server is never changed. Genuinely
// unreachable cases (RC4/3DES needing the OpenSSL legacy provider, or plaintext)
// stay on the sidecar / Bridge Agent line. stream() uses batch fetch, not a true
// cursor.
import type {
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  DbValue,
  WhereClause,
  Transaction,
  ConnectionConfig
} from './BaseAdapter';
import { BaseDataAdapter, getStringConfig, getNumberConfig } from './BaseAdapter'

// Minimal structural typing for the optional `mssql` driver (avoid `any` and a
// hard build-time dependency on @types/mssql).
interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest
  query<T = unknown>(sql: string): Promise<{ recordset?: T[]; rowsAffected?: number[] }>
}
interface MssqlConnectionPool {
  connect(): Promise<MssqlConnectionPool>
  close(): Promise<void>
  request(): MssqlRequest
}
interface MssqlTransaction {
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown>) => MssqlConnectionPool
  Transaction: new (pool: MssqlConnectionPool) => MssqlTransaction
}

let mssql: MssqlModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mssql = require('mssql') as MssqlModule
} catch {
  // mssql not installed; connect()/testConnection() report a clear error.
}

interface MssqlColumnRow {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
  character_maximum_length: number | null
  numeric_precision: number | null
  numeric_scale: number | null
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['false', '0', 'no', 'off'].includes(s)) return false
    if (['true', '1', 'yes', 'on'].includes(s)) return true
  }
  return fallback
}

type FKActionType = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION'
function mapFKAction(rule: string): FKActionType {
  const normalized = (rule || '').toUpperCase().replace(/_/g, ' ')
  if (normalized === 'CASCADE' || normalized === 'RESTRICT' || normalized === 'SET NULL') {
    return normalized
  }
  return 'NO ACTION'
}

export class MSSQLAdapter extends BaseDataAdapter {
  protected override pool: MssqlConnectionPool | null = null

  override isSqlDialect(): boolean {
    return true
  }

  /**
   * Resolve server + port from connection config. `host` wins over `server`;
   * when only `server` is given it may carry a port (`host:port` or `host,port`),
   * and if an explicit `port` is also given the two must agree.
   */
  private resolveServerAndPort(): { server: string; port?: number } {
    const host = getStringConfig(this.config.connection.host)
    const serverRaw = getStringConfig(this.config.connection.server)
    const explicitPort = getNumberConfig(this.config.connection.port)

    if (host) {
      return { server: host, ...(explicitPort != null ? { port: explicitPort } : {}) }
    }
    if (serverRaw) {
      const m = serverRaw.match(/^(.*?)[:,](\d+)$/)
      if (m) {
        const parsedPort = parseInt(m[2], 10)
        if (explicitPort != null && explicitPort !== parsedPort) {
          throw new Error(
            `Conflicting port: connection.port=${explicitPort} but connection.server specifies ${parsedPort}`
          )
        }
        return { server: m[1], port: explicitPort ?? parsedPort }
      }
      return { server: serverRaw, ...(explicitPort != null ? { port: explicitPort } : {}) }
    }
    throw new Error('SQL Server data source requires connection.host or connection.server')
  }

  // Valid TLS protocol floors accepted by Node's tls module (B3 validation).
  private static readonly VALID_TLS_MIN_VERSIONS: readonly string[] = [
    'TLSv1',
    'TLSv1.1',
    'TLSv1.2',
    'TLSv1.3'
  ]

  /**
   * B3 — per-connection legacy-TLS escape hatch. SECURE BY DEFAULT: returns
   * undefined unless this source explicitly opts down. When a legacy SQL Server
   * (e.g. 2008R2/2012) cannot negotiate modern TLS, an operator may lower the
   * TLS floor / cipher security level for THIS connection only — the customer's
   * server is never touched, and the scope is never process-wide.
   *
   *   connection.tlsMinVersion  -> cryptoCredentialsDetails.minVersion ('TLSv1' …)
   *   connection.tlsCiphers     -> cryptoCredentialsDetails.ciphers    ('DEFAULT@SECLEVEL=0' …)
   *   connection.legacyTls=true -> convenience: applies the documented legacy
   *                                defaults above unless an explicit key overrides.
   *
   * The wire stays encrypted (this lowers the floor, it is not `encrypt:false`).
   * Lowering below the secure default emits an audit signal.
   */
  private buildLegacyTlsOptions(conn: ConnectionConfig): { minVersion?: string; ciphers?: string } | undefined {
    const legacyTls = coerceBoolean(conn.legacyTls, false)
    let minVersion = getStringConfig(conn.tlsMinVersion)
    let ciphers = getStringConfig(conn.tlsCiphers)

    if (legacyTls) {
      // Documented legacy defaults; explicit keys win.
      minVersion = minVersion ?? 'TLSv1'
      ciphers = ciphers ?? 'DEFAULT@SECLEVEL=0'
    }

    // No downgrade requested → keep Node/tedious secure defaults (TLSv1.2 floor).
    if (minVersion === undefined && ciphers === undefined) return undefined

    // B3 lowers the TLS floor but keeps the wire ENCRYPTED. It must not be
    // combined with connection.encrypt=false — that is a SEPARATE plaintext
    // escape hatch with a different security posture. Allowing both would make
    // the audit below falsely claim "wire stays encrypted" for a plaintext
    // source. Reject the contradiction loudly; the plaintext path is opt-in on
    // its own (encrypt=false with no TLS-downgrade keys).
    if (coerceBoolean(conn.encrypt, true) === false) {
      throw new Error(
        'connection.encrypt=false cannot be combined with the legacy-TLS lever ' +
          '(legacyTls / tlsMinVersion / tlsCiphers): the TLS downgrade keeps the wire ' +
          'encrypted, while encrypt=false is a separate plaintext escape hatch — use one or the other.'
      )
    }

    // Enum-strict: never silently fall back to a default for a bad floor value.
    if (minVersion !== undefined && !MSSQLAdapter.VALID_TLS_MIN_VERSIONS.includes(minVersion)) {
      throw new Error(
        `Invalid connection.tlsMinVersion "${minVersion}" ` +
          `(expected one of ${MSSQLAdapter.VALID_TLS_MIN_VERSIONS.join(', ')})`
      )
    }

    // Audit: this source is connecting with a deliberately lowered TLS posture.
    const detail = [
      minVersion !== undefined ? `minVersion=${minVersion}` : null,
      ciphers !== undefined ? `ciphers=${ciphers}` : null
    ]
      .filter(Boolean)
      .join(', ')
    this.emit('tls-downgrade', { adapter: this.config.name, minVersion, ciphers })
    console.warn(
      `[MSSQLAdapter] legacy TLS enabled for data source "${this.config.name}" (${detail}); ` +
        `wire stays encrypted, scope is this connection only.`
    )

    return {
      ...(minVersion !== undefined ? { minVersion } : {}),
      ...(ciphers !== undefined ? { ciphers } : {})
    }
  }

  private buildPoolConfig(): Record<string, unknown> {
    const conn = this.config.connection
    const { server, port } = this.resolveServerAndPort()
    const legacyTls = this.buildLegacyTlsOptions(conn)
    return {
      server,
      ...(port != null ? { port } : {}),
      database: getStringConfig(conn.database),
      user: getStringConfig(this.config.credentials?.username),
      password: getStringConfig(this.config.credentials?.password),
      // Secure by default: encrypt the wire; trust the (typically self-signed)
      // intranet certificate. Set connection.encrypt=false only as an explicit
      // per-source escape hatch for a legacy server that cannot negotiate TLS.
      // cryptoCredentialsDetails (B3) lowers the TLS floor/ciphers per-source
      // for genuinely old servers — still encrypted, opt-in only.
      options: {
        encrypt: coerceBoolean(conn.encrypt, true),
        trustServerCertificate: coerceBoolean(conn.trustServerCertificate, true),
        ...(legacyTls ? { cryptoCredentialsDetails: legacyTls } : {})
      },
      // ?? (not ||) so an explicit 0 ("no timeout" in mssql) is not overridden.
      connectionTimeout: getNumberConfig(conn.connectionTimeoutMs) ?? 10000,
      requestTimeout: getNumberConfig(conn.requestTimeoutMs) ?? 30000,
      pool: {
        max: this.config.poolConfig?.max || 20,
        min: this.config.poolConfig?.min || 0
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (!mssql) {
      throw new Error('mssql package is not installed')
    }
    try {
      this.pool = new mssql.ConnectionPool(this.buildPoolConfig())
      await this.pool.connect()
      await this.pool.request().query('SELECT 1 AS ok')
      this.connected = true
      await this.onConnect()
    } catch (error) {
      this.pool = null
      await this.onError(error as Error)
      throw new Error(`Failed to connect to SQL Server: ${error}`)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.pool) return
    try {
      await this.pool.close()
      this.pool = null
      this.connected = false
      await this.onDisconnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to disconnect from SQL Server: ${error}`)
    }
  }

  isConnected(): boolean {
    return this.connected && this.pool !== null
  }

  async testConnection(): Promise<boolean> {
    if (!this.pool) return false
    try {
      const result = await this.pool.request().query<{ ok: number }>('SELECT 1 AS ok')
      return (result.recordset?.length ?? 0) > 0
    } catch (error) {
      await this.onError(error as Error) // A3: record the redacted cause (else the test failure is silent)
      return false
    }
  }

  // A2: bracket-quote PER SEGMENT so a schema-qualified name becomes [schema].[table]. The base
  // sanitizer validates each segment and throws on illegal input.
  private quoteIdent(identifier: string): string {
    return this.sanitizeIdentifier(identifier).split('.').map(seg => `[${seg}]`).join('.')
  }

  async query<T = Record<string, DbValue>>(sql: string, params?: DbValue[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }
    try {
      const request = this.pool.request()
      const values = params || []
      values.forEach((value, i) => request.input(`p${i}`, value))
      // Framework convention uses $1-style placeholders; translate to mssql @pN.
      const translated = sql.replace(/\$(\d+)/g, (_m, n) => `@p${parseInt(n, 10) - 1}`)
      const result = await request.query<T>(translated)
      const rows = result.recordset ?? []
      return {
        data: rows as T[],
        metadata: {
          totalCount: result.rowsAffected?.[0] ?? rows.length
        }
      }
    } catch (error) {
      return { data: [], error: error as Error }
    }
  }

  async select<T = Record<string, DbValue>>(table: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    const selectClause = options.select?.length
      ? options.select.map(col => this.quoteIdent(col)).join(', ')
      : '*'

    // A5: `limit` is always a bounded positive int (omit -> MAX cap, > MAX -> throw), so a direct
    // internal caller cannot issue an unbounded read.
    const limit = this.resolveEffectiveLimit(options.limit)
    const offset = options.offset != null ? Math.floor(Number(options.offset)) : null
    // limit-without-offset uses TOP (no ORDER BY required); offset uses OFFSET/FETCH.
    const useTop = offset == null || offset === 0

    let sql = `SELECT ${useTop ? `TOP (${limit}) ` : ''}${selectClause} FROM ${this.quoteIdent(table)}`
    let params: DbValue[] = []

    if (options.joins?.length) {
      for (const join of options.joins) {
        const joinType = join.type?.toUpperCase() || 'INNER'
        sql += ` ${joinType} JOIN ${this.quoteIdent(join.table)} ON ${join.on}`
      }
    }

    if (options.where && Object.keys(options.where).length > 0) {
      const whereClause = this.buildWhereClause(options.where)
      sql += ` ${whereClause.sql}`
      params = whereClause.params
    }

    const orderBy = options.orderBy?.length
      ? options.orderBy.map(o => `${this.quoteIdent(o.column)} ${o.direction.toUpperCase()}`).join(', ')
      : null

    if (offset != null && offset > 0) {
      // OFFSET requires an ORDER BY; fall back to a stable no-op ordering.
      sql += ` ORDER BY ${orderBy ?? '(SELECT NULL)'} OFFSET ${offset} ROWS`
      sql += ` FETCH NEXT ${limit} ROWS ONLY`
    } else if (orderBy) {
      sql += ` ORDER BY ${orderBy}`
    }

    return this.query<T>(sql, params)
  }

  async insert<T = Record<string, DbValue>>(
    table: string,
    data: Record<string, DbValue> | Record<string, DbValue>[]
  ): Promise<QueryResult<T>> {
    const records = Array.isArray(data) ? data : [data]
    if (records.length === 0) return { data: [] }

    const columns = Object.keys(records[0])
    const quotedColumns = columns.map(col => this.quoteIdent(col))
    const values: DbValue[] = []
    const valuePlaceholders: string[] = []
    let paramIndex = 1

    for (const record of records) {
      const recordPlaceholders: string[] = []
      for (const column of columns) {
        recordPlaceholders.push(`$${paramIndex++}`)
        values.push(record[column])
      }
      valuePlaceholders.push(`(${recordPlaceholders.join(', ')})`)
    }

    const sql =
      `INSERT INTO ${this.quoteIdent(table)} (${quotedColumns.join(', ')}) ` +
      `OUTPUT INSERTED.* VALUES ${valuePlaceholders.join(', ')}`

    return this.query<T>(sql, values)
  }

  async update<T = Record<string, DbValue>>(
    table: string,
    data: Record<string, DbValue>,
    where: WhereClause
  ): Promise<QueryResult<T>> {
    const setClause: string[] = []
    const values: DbValue[] = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(data)) {
      setClause.push(`${this.quoteIdent(key)} = $${paramIndex++}`)
      values.push(value)
    }

    const whereClause = this.buildWhereClause(where)
    // Shift the where-clause placeholder indices past the SET values.
    const adjustedWhere = whereClause.sql.replace(/\$(\d+)/g, (_m, p1) => `$${parseInt(p1, 10) + values.length}`)

    const sql =
      `UPDATE ${this.quoteIdent(table)} SET ${setClause.join(', ')} ` +
      `OUTPUT INSERTED.* ${adjustedWhere}`

    return this.query<T>(sql, [...values, ...whereClause.params])
  }

  async delete<T = Record<string, DbValue>>(
    table: string,
    where: WhereClause
  ): Promise<QueryResult<T>> {
    const whereClause = this.buildWhereClause(where)
    const sql = `DELETE FROM ${this.quoteIdent(table)} OUTPUT DELETED.* ${whereClause.sql}`
    return this.query<T>(sql, whereClause.params)
  }

  async getSchema(schema: string = 'dbo'): Promise<SchemaInfo> {
    const tablesQuery =
      `SELECT TABLE_NAME AS table_name, TABLE_SCHEMA AS table_schema ` +
      `FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = $1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
    const viewsQuery =
      `SELECT TABLE_NAME AS view_name, TABLE_SCHEMA AS view_schema, VIEW_DEFINITION AS view_definition ` +
      `FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = $1 ORDER BY TABLE_NAME`

    const [tablesResult, viewsResult] = await Promise.all([
      this.query<{ table_name: string; table_schema: string }>(tablesQuery, [schema]),
      this.query<{ view_name: string; view_schema: string; view_definition: string }>(viewsQuery, [schema])
    ])

    const tables: TableInfo[] = []
    for (const row of tablesResult.data) {
      tables.push(await this.getTableInfo(row.table_name, row.table_schema))
    }
    const views = viewsResult.data.map(row => ({
      name: row.view_name,
      schema: row.view_schema,
      definition: row.view_definition,
      columns: []
    }))
    return { tables, views }
  }

  async getTableInfo(table: string, schema: string = 'dbo'): Promise<TableInfo> {
    const columns = await this.getColumns(table, schema)

    const pkQuery =
      `SELECT kcu.COLUMN_NAME AS column_name ` +
      `FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ` +
      `JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ` +
      `  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA ` +
      `WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = $1 AND tc.TABLE_SCHEMA = $2 ` +
      `ORDER BY kcu.ORDINAL_POSITION`
    const pkResult = await this.query<{ column_name: string }>(pkQuery, [table, schema])
    const primaryKey = pkResult.data.map(r => r.column_name)

    const indexQuery =
      `SELECT i.name AS index_name, i.is_unique AS is_unique, c.name AS column_name ` +
      `FROM sys.indexes i ` +
      `JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id ` +
      `JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id ` +
      `JOIN sys.tables t ON t.object_id = i.object_id ` +
      `WHERE t.name = $1 AND i.is_primary_key = 0 AND i.type > 0 ` +
      `ORDER BY i.name, ic.key_ordinal`
    const indexResult = await this.query<{ index_name: string; is_unique: boolean; column_name: string }>(
      indexQuery,
      [table]
    )
    const indexMap = new Map<string, IndexInfo>()
    for (const row of indexResult.data) {
      const existing = indexMap.get(row.index_name)
      if (existing) existing.columns.push(row.column_name)
      else indexMap.set(row.index_name, { name: row.index_name, columns: [row.column_name], unique: !!row.is_unique })
    }
    const indexes: IndexInfo[] = [...indexMap.values()]

    const fkQuery =
      `SELECT fk.name AS constraint_name, cpa.name AS column_name, rt.name AS referenced_table, ` +
      `       cref.name AS referenced_column, fk.update_referential_action_desc AS update_rule, ` +
      `       fk.delete_referential_action_desc AS delete_rule ` +
      `FROM sys.foreign_keys fk ` +
      `JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id ` +
      `JOIN sys.tables t ON t.object_id = fk.parent_object_id ` +
      `JOIN sys.columns cpa ON cpa.object_id = t.object_id AND cpa.column_id = fkc.parent_column_id ` +
      `JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id ` +
      `JOIN sys.columns cref ON cref.object_id = rt.object_id AND cref.column_id = fkc.referenced_column_id ` +
      `WHERE t.name = $1`
    const fkResult = await this.query<{
      constraint_name: string
      column_name: string
      referenced_table: string
      referenced_column: string
      update_rule: string
      delete_rule: string
    }>(fkQuery, [table])
    const foreignKeys: ForeignKeyInfo[] = fkResult.data.map(r => ({
      name: r.constraint_name,
      column: r.column_name,
      referencedTable: r.referenced_table,
      referencedColumn: r.referenced_column,
      onUpdate: mapFKAction(r.update_rule),
      onDelete: mapFKAction(r.delete_rule)
    }))

    return { name: table, schema, columns, primaryKey, indexes, foreignKeys }
  }

  async getColumns(table: string, schema: string = 'dbo'): Promise<ColumnInfo[]> {
    const query =
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, ` +
      `       COLUMN_DEFAULT AS column_default, CHARACTER_MAXIMUM_LENGTH AS character_maximum_length, ` +
      `       NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale ` +
      `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = $1 AND TABLE_SCHEMA = $2 ORDER BY ORDINAL_POSITION`
    const result = await this.query<MssqlColumnRow>(query, [table, schema])
    return result.data.map(row => ({
      name: row.column_name,
      type: this.formatColumnType(row),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      comment: undefined
    }))
  }

  async tableExists(table: string, schema: string = 'dbo'): Promise<boolean> {
    const query =
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = $1 AND TABLE_NAME = $2`
    const result = await this.query<{ cnt: number }>(query, [schema, table])
    return (result.data[0]?.cnt ?? 0) > 0
  }

  async beginTransaction(): Promise<Transaction> {
    if (!this.pool || !mssql) {
      throw new Error('Not connected to database')
    }
    const txn = new mssql.Transaction(this.pool)
    await txn.begin()
    return txn as unknown as Transaction
  }

  async commit(transaction: Transaction): Promise<void> {
    await (transaction as unknown as MssqlTransaction).commit()
  }

  async rollback(transaction: Transaction): Promise<void> {
    await (transaction as unknown as MssqlTransaction).rollback()
  }

  async inTransaction<R = unknown>(transaction: Transaction, callback: () => Promise<R>): Promise<R> {
    try {
      const result = await callback()
      await this.commit(transaction)
      return result
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }

  async *stream<T = Record<string, DbValue>>(
    sql: string,
    params?: DbValue[],
    _options?: { highWaterMark?: number; objectMode?: boolean }
  ): AsyncIterableIterator<T> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }
    // Conservative: batch fetch then iterate (no true cursor), matching the
    // other adapters.
    const result = await this.query<T>(sql, params)
    for (const row of result.data) {
      yield row
    }
  }

  private formatColumnType(column: MssqlColumnRow): string {
    let type = column.data_type
    if (column.character_maximum_length) {
      type += `(${column.character_maximum_length})`
    } else if (column.numeric_precision) {
      type += `(${column.numeric_precision}`
      if (column.numeric_scale) type += `,${column.numeric_scale}`
      type += ')'
    }
    return type
  }
}
