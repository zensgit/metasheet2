// MySQL types (optional dependency)
interface MySQLConnection {
  ping(): Promise<void>
  release(): void
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  execute(sql: string, params?: unknown[]): {
    stream(): AsyncIterable<unknown>
  } & Promise<[unknown[], unknown[]]>
}

interface MySQLPool {
  getConnection(): Promise<MySQLConnection>
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown[]]>
  end(): Promise<void>
}

type PoolConnection = MySQLConnection

interface MySQLFieldPacket {
  name: string
  type?: number
  flags?: number
}

interface MySQLModule {
  createPool(config: Record<string, unknown>): MySQLPool
}

interface MySQLResultRow {
  insertId?: number
  [key: string]: unknown
}

// Dynamic mysql2 import
let mysql: MySQLModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mysql = require('mysql2/promise') as MySQLModule
} catch {
  // mysql2 not installed
}
import type {
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  DbValue,
  WhereClause
} from './BaseAdapter';
import {
  BaseDataAdapter,
  DataSourceConfig as _DataSourceConfig
} from './BaseAdapter'

export class MySQLAdapter extends BaseDataAdapter {
  protected override pool: MySQLPool | null = null

  override isSqlDialect(): boolean {
    return true
  }

  /**
   * Convert DbValue to string, ensuring it's a valid database name
   */
  private dbValueToString(value: DbValue): string {
    if (typeof value === 'string') {
      return value
    }
    if (value === null || value === undefined) {
      throw new Error('Database name cannot be null or undefined')
    }
    return String(value)
  }

  /**
   * Sanitize and quote MySQL identifier (table/column names)
   * Prevents SQL injection by removing dangerous characters and properly quoting
   */
  private sanitizeMySQLIdentifier(identifier: string): string {
    // A2: backtick-quote PER SEGMENT so a schema-qualified name becomes `schema`.`table`. The base
    // sanitizer validates each segment and throws on illegal input.
    return this.sanitizeIdentifier(identifier).split('.').map(seg => `\`${seg}\``).join('.')
  }

  private getMySQLOperator(op: string): string {
    const operators: Record<string, string> = {
      $gt: '>',
      $gte: '>=',
      $lt: '<',
      $lte: '<=',
      $ne: '!=',
      $like: 'LIKE',
      $ilike: 'LIKE',
      $in: 'IN',
      $nin: 'NOT IN',
      $between: 'BETWEEN'
    }
    const operator = operators[op]
    if (!operator) {
      throw new Error(`Unsupported where operator: ${op}`)
    }
    return operator
  }

  private buildMySQLWhereClause(where: WhereClause): { sql: string; params: DbValue[] } {
    const result = this.buildMySQLWhereConditions(where)
    return {
      sql: result.conditions.length > 0 ? `WHERE ${result.conditions.join(' AND ')}` : '',
      params: result.params
    }
  }

  private buildMySQLWhereConditions(where: WhereClause): { conditions: string[]; params: DbValue[] } {
    const conditions: string[] = []
    const params: DbValue[] = []

    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) {
        continue
      }
      if (key === '$or' || key === '$and') {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`${key} must be a non-empty array of where clauses`)
        }
        const nestedParts: string[] = []
        const clauses = value as WhereClause[]
        for (const clause of clauses) {
          if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
            throw new Error(`${key} entries must be where clause objects`)
          }
          const nested = this.buildMySQLWhereConditions(clause)
          params.push(...nested.params)
          if (nested.conditions.length === 0) {
            throw new Error(`${key} entries must not be empty`)
          }
          nestedParts.push(`(${nested.conditions.join(' AND ')})`)
        }
        conditions.push(`(${nestedParts.join(key === '$or' ? ' OR ' : ' AND ')})`)
      } else if (value === null) {
        conditions.push(`${this.sanitizeMySQLIdentifier(key)} IS NULL`)
      } else if (Array.isArray(value)) {
        const list = value as DbValue[]
        const placeholders = list.map(() => '?').join(', ')
        conditions.push(`${this.sanitizeMySQLIdentifier(key)} IN (${placeholders})`)
        params.push(...list)
      } else if (value && typeof value === 'object') {
        const entries = Object.entries(value)
        if (entries.length > 0 && entries.some(([op]) => op.startsWith('$'))) {
          for (const [op, operatorValue] of entries) {
            if (operatorValue === undefined) continue
            const operator = this.getMySQLOperator(op)
            if (op === '$in' || op === '$nin') {
              if (!Array.isArray(operatorValue) || operatorValue.length === 0) {
                throw new Error(`${op} must be a non-empty array`)
              }
              const values = operatorValue as DbValue[]
              const placeholders = values.map(() => '?').join(', ')
              conditions.push(`${this.sanitizeMySQLIdentifier(key)} ${operator} (${placeholders})`)
              params.push(...values)
            } else if (op === '$between') {
              if (!Array.isArray(operatorValue) || operatorValue.length !== 2) {
                throw new Error('$between must be a two-value array')
              }
              conditions.push(`${this.sanitizeMySQLIdentifier(key)} BETWEEN ? AND ?`)
              params.push(...(operatorValue as [DbValue, DbValue]))
            } else {
              conditions.push(`${this.sanitizeMySQLIdentifier(key)} ${operator} ?`)
              params.push(operatorValue as DbValue)
            }
          }
        } else {
          conditions.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
          params.push(value as DbValue)
        }
      } else {
        conditions.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
        params.push(value as DbValue)
      }
    }

    return { conditions, params }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }

    if (!mysql) {
      throw new Error('mysql2 package is not installed')
    }

    try {
      this.pool = mysql.createPool({
        host: this.config.connection.host,
        port: this.config.connection.port || 3306,
        database: this.config.connection.database,
        user: this.config.credentials?.username,
        password: this.config.credentials?.password,
        ssl: this.config.connection.ssl,
        connectionLimit: this.config.poolConfig?.max || 20,
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        ...this.config.options
      })

      // Test connection
      const connection = await this.pool.getConnection()
      await connection.ping()
      connection.release()

      this.connected = true
      await this.onConnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to connect to MySQL: ${error}`)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.pool) {
      return
    }

    try {
      await this.pool.end()
      this.pool = null
      this.connected = false
      await this.onDisconnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to disconnect from MySQL: ${error}`)
    }
  }

  isConnected(): boolean {
    return this.connected && this.pool !== null
  }

  async testConnection(): Promise<boolean> {
    if (!this.pool) {
      return false
    }

    try {
      const connection = await this.pool.getConnection()
      await connection.ping()
      connection.release()
      return true
    } catch {
      return false
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    try {
      const [rows, fields] = await this.pool.execute(sql, params) as [unknown[], MySQLFieldPacket[]]

      return {
        data: rows as T[],
        metadata: {
          totalCount: Array.isArray(rows) ? rows.length : 0,
          columns: fields?.map((field: MySQLFieldPacket) => ({
            name: field.name,
            type: this.mapMySQLType(field.type!),
            nullable: !!(field.flags! & 1)
          }))
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async select<T = Record<string, unknown>>(table: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    const selectClause = options.select?.length
      ? options.select.map(col => this.sanitizeMySQLIdentifier(col)).join(', ')
      : '*'

    let sql = `SELECT ${selectClause} FROM ${this.sanitizeMySQLIdentifier(table)}`
    const params: unknown[] = []

    // Add joins
    if (options.joins?.length) {
      for (const join of options.joins) {
        const joinType = join.type?.toUpperCase() || 'INNER'
        sql += ` ${joinType} JOIN ${this.sanitizeMySQLIdentifier(join.table)} ON ${join.on}`
      }
    }

    if (options.where && Object.keys(options.where).length > 0) {
      const whereClause = this.buildMySQLWhereClause(options.where)
      sql += ` ${whereClause.sql}`
      params.push(...whereClause.params)
    }

    // Add order by
    if (options.orderBy?.length) {
      const orderClauses = options.orderBy.map(
        order => `${this.sanitizeMySQLIdentifier(order.column)} ${order.direction.toUpperCase()}`
      )
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    // Add limit and offset (these are numeric, validate them)
    if (options.limit) {
      const limit = parseInt(String(options.limit), 10)
      if (!isNaN(limit) && limit > 0) {
        sql += ` LIMIT ${limit}`
      }
    }
    if (options.offset) {
      const offset = parseInt(String(options.offset), 10)
      if (!isNaN(offset) && offset >= 0) {
        sql += ` OFFSET ${offset}`
      }
    }

    return this.query<T>(sql, params)
  }

  async insert<T = Record<string, unknown>>(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<QueryResult<T>> {
    const records = Array.isArray(data) ? data : [data]
    if (records.length === 0) {
      return { data: [] }
    }

    const columns = Object.keys(records[0])
    const columnNames = columns.map(col => this.sanitizeMySQLIdentifier(col)).join(', ')
    const values: unknown[] = []
    const valuePlaceholders: string[] = []

    for (const record of records) {
      const recordPlaceholders = columns.map(() => '?')
      valuePlaceholders.push(`(${recordPlaceholders.join(', ')})`)

      for (const column of columns) {
        values.push(record[column])
      }
    }

    const sanitizedTable = this.sanitizeMySQLIdentifier(table)
    const sql = `
      INSERT INTO ${sanitizedTable} (${columnNames})
      VALUES ${valuePlaceholders.join(', ')}
    `

    const result = await this.query<T>(sql, values)

    // MySQL doesn't return inserted rows by default
    // We need to query them separately if needed
    if (result.data.length > 0) {
      const firstRow = result.data[0] as MySQLResultRow
      if (firstRow.insertId !== undefined) {
        const selectSql = `SELECT * FROM ${sanitizedTable} WHERE id >= ? LIMIT ?`
        return this.query<T>(selectSql, [firstRow.insertId, records.length])
      }
    }

    return result
  }

  async update<T = Record<string, unknown>>(table: string, data: Record<string, unknown>, where: WhereClause): Promise<QueryResult<T>> {
    const setClause: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(data)) {
      setClause.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
      values.push(value)
    }

    const whereClause = this.buildMySQLWhereClause(where)
    if (!whereClause.sql) {
      throw new Error('MySQL update requires a non-empty where clause')
    }
    values.push(...whereClause.params)

    const sql = `
      UPDATE ${this.sanitizeMySQLIdentifier(table)}
      SET ${setClause.join(', ')}
      ${whereClause.sql}
    `

    return this.query<T>(sql, values)
  }

  async delete<T = Record<string, unknown>>(table: string, where: WhereClause): Promise<QueryResult<T>> {
    const whereClause = this.buildMySQLWhereClause(where)
    if (!whereClause.sql) {
      throw new Error('MySQL delete requires a non-empty where clause')
    }

    const sql = `
      DELETE FROM ${this.sanitizeMySQLIdentifier(table)}
      ${whereClause.sql}
    `

    return this.query<T>(sql, whereClause.params)
  }

  async getSchema(schema?: string): Promise<SchemaInfo> {
    const database = schema || this.dbValueToString(this.config.connection.database)

    const tablesQuery = `
      SELECT
        TABLE_NAME as table_name,
        TABLE_SCHEMA as table_schema
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `

    const viewsQuery = `
      SELECT
        TABLE_NAME as view_name,
        TABLE_SCHEMA as view_schema,
        VIEW_DEFINITION as view_definition
      FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `

    const [tablesResult, viewsResult] = await Promise.all([
      this.query<{ table_name: string; table_schema: string }>(tablesQuery, [database]),
      this.query<{ view_name: string; view_schema: string; view_definition: string }>(viewsQuery, [database])
    ])

    const tables: TableInfo[] = []
    for (const row of tablesResult.data) {
      const tableInfo = await this.getTableInfo(row.table_name, row.table_schema)
      tables.push(tableInfo)
    }

    const views = viewsResult.data.map(row => ({
      name: row.view_name,
      schema: row.view_schema,
      definition: row.view_definition,
      columns: [] // Would need additional query to get column info
    }))

    return { tables, views }
  }

  async getTableInfo(table: string, schema?: string): Promise<TableInfo> {
    const database = schema || this.dbValueToString(this.config.connection.database)
    const columns = await this.getColumns(table, database)

    // Get primary key info
    const pkQuery = `
      SELECT COLUMN_NAME as column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `

    const pkResult = await this.query<{ column_name: string }>(pkQuery, [database, table])
    const primaryKey = pkResult.data.map(row => row.column_name)

    // Get indexes
    const indexQuery = `
      SELECT
        INDEX_NAME as index_name,
        NON_UNIQUE = 0 as is_unique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME != 'PRIMARY'
      GROUP BY INDEX_NAME, NON_UNIQUE
    `

    const indexResult = await this.query<{ index_name: string; is_unique: boolean; columns: string }>(
      indexQuery,
      [database, table]
    )

    const indexes: IndexInfo[] = indexResult.data.map(row => ({
      name: row.index_name,
      columns: row.columns.split(','),
      unique: row.is_unique
    }))

    // Get foreign keys
    const fkQuery = `
      SELECT
        CONSTRAINT_NAME as constraint_name,
        COLUMN_NAME as column_name,
        REFERENCED_TABLE_NAME as referenced_table,
        REFERENCED_COLUMN_NAME as referenced_column
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `

    const fkResult = await this.query<{
      constraint_name: string
      column_name: string
      referenced_table: string
      referenced_column: string
    }>(fkQuery, [database, table])

    const foreignKeys: ForeignKeyInfo[] = fkResult.data.map(row => ({
      name: row.constraint_name,
      column: row.column_name,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column
    }))

    return {
      name: table,
      schema: database,
      columns,
      primaryKey,
      indexes,
      foreignKeys
    }
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const database = schema || this.dbValueToString(this.config.connection.database)

    const query = `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as max_length,
        NUMERIC_PRECISION as numeric_precision,
        NUMERIC_SCALE as numeric_scale,
        COLUMN_COMMENT as column_comment,
        EXTRA as extra_info
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `

    const result = await this.query<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      max_length: number | null
      numeric_precision: number | null
      numeric_scale: number | null
      column_comment: string | null
      extra_info: string
    }>(query, [database, table])

    return result.data.map(row => ({
      name: row.column_name,
      type: this.formatColumnType(row),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      autoIncrement: row.extra_info.includes('auto_increment'),
      comment: row.column_comment || undefined
    }))
  }

  async tableExists(table: string, schema?: string): Promise<boolean> {
    const database = schema || this.dbValueToString(this.config.connection.database)

    const query = `
      SELECT COUNT(*) as count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND TABLE_TYPE = 'BASE TABLE'
    `

    const result = await this.query<{ count: number }>(query, [database, table])
    return result.data[0]?.count > 0
  }

  async beginTransaction(): Promise<PoolConnection> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    return connection
  }

  async commit(transaction: PoolConnection): Promise<void> {
    try {
      await transaction.commit()
    } finally {
      transaction.release()
    }
  }

  async rollback(transaction: PoolConnection): Promise<void> {
    try {
      await transaction.rollback()
    } finally {
      transaction.release()
    }
  }

  async inTransaction<T>(transaction: PoolConnection, callback: () => Promise<T>): Promise<T> {
    try {
      const result = await callback()
      await this.commit(transaction)
      return result
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }

  async *stream<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    _options?: { highWaterMark?: number }
  ): AsyncIterableIterator<T> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    const connection = await this.pool.getConnection()

    try {
      const stream = connection.execute(sql, params).stream()

      for await (const row of stream) {
        yield row as T
      }
    } finally {
      connection.release()
    }
  }

  private mapMySQLType(type: number): string {
    const typeMap: Record<number, string> = {
      1: 'tinyint',
      2: 'smallint',
      3: 'int',
      4: 'float',
      5: 'double',
      6: 'null',
      7: 'timestamp',
      8: 'bigint',
      9: 'mediumint',
      10: 'date',
      11: 'time',
      12: 'datetime',
      13: 'year',
      252: 'text',
      253: 'varchar',
      254: 'char'
    }

    return typeMap[type] || 'unknown'
  }

  private formatColumnType(column: {
    data_type: string
    max_length: number | null
    numeric_precision: number | null
    numeric_scale: number | null
  }): string {
    let type = column.data_type

    if (column.max_length && ['varchar', 'char'].includes(column.data_type)) {
      type += `(${column.max_length})`
    } else if (column.numeric_precision && ['decimal', 'numeric'].includes(column.data_type)) {
      type += `(${column.numeric_precision}`
      if (column.numeric_scale) {
        type += `,${column.numeric_scale}`
      }
      type += ')'
    }

    return type
  }
}
