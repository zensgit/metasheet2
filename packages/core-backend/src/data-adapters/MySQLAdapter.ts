// @ts-nocheck
import mysql, { Pool, PoolConnection, RowDataPacket, FieldPacket } from 'mysql2/promise'
import {
  BaseDataAdapter,
  DataSourceConfig,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo
} from './BaseAdapter'

export class MySQLAdapter extends BaseDataAdapter {
  private pool: Pool | null = null

  /**
   * Sanitize and quote MySQL identifier (table/column names)
   * Prevents SQL injection by removing dangerous characters and properly quoting
   */
  private sanitizeMySQLIdentifier(identifier: string): string {
    // First sanitize using parent method to remove dangerous characters
    const sanitized = this.sanitizeIdentifier(identifier)
    // Then wrap in backticks for MySQL
    return `\`${sanitized}\``
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return
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

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    try {
      const [rows, fields] = await this.pool.execute<RowDataPacket[]>(sql, params)

      return {
        data: rows as T[],
        metadata: {
          totalCount: Array.isArray(rows) ? rows.length : 0,
          columns: fields?.map((field: FieldPacket) => ({
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

  async select<T = any>(table: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    const selectClause = options.select?.length
      ? options.select.map(col => this.sanitizeMySQLIdentifier(col)).join(', ')
      : '*'

    let sql = `SELECT ${selectClause} FROM ${this.sanitizeMySQLIdentifier(table)}`
    const params: any[] = []

    // Add joins
    if (options.joins?.length) {
      for (const join of options.joins) {
        const joinType = join.type?.toUpperCase() || 'INNER'
        sql += ` ${joinType} JOIN ${this.sanitizeMySQLIdentifier(join.table)} ON ${join.on}`
      }
    }

    // Add where clause
    if (options.where && Object.keys(options.where).length > 0) {
      const conditions: string[] = []

      for (const [key, value] of Object.entries(options.where)) {
        if (value === null) {
          conditions.push(`${this.sanitizeMySQLIdentifier(key)} IS NULL`)
        } else if (Array.isArray(value)) {
          const placeholders = value.map(() => '?').join(', ')
          conditions.push(`${this.sanitizeMySQLIdentifier(key)} IN (${placeholders})`)
          params.push(...value)
        } else {
          conditions.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
          params.push(value)
        }
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`
      }
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

  async insert<T = any>(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>> {
    const records = Array.isArray(data) ? data : [data]
    if (records.length === 0) {
      return { data: [] }
    }

    const columns = Object.keys(records[0])
    const columnNames = columns.map(col => this.sanitizeMySQLIdentifier(col)).join(', ')
    const values: any[] = []
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
    if ((result as any).insertId) {
      const selectSql = `SELECT * FROM ${sanitizedTable} WHERE id >= ? LIMIT ?`
      return this.query<T>(selectSql, [(result as any).insertId, records.length])
    }

    return result
  }

  async update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>> {
    const setClause: string[] = []
    const values: any[] = []

    for (const [key, value] of Object.entries(data)) {
      setClause.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
      values.push(value)
    }

    const whereConditions: string[] = []
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        whereConditions.push(`${this.sanitizeMySQLIdentifier(key)} IS NULL`)
      } else {
        whereConditions.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
        values.push(value)
      }
    }

    const sql = `
      UPDATE ${this.sanitizeMySQLIdentifier(table)}
      SET ${setClause.join(', ')}
      WHERE ${whereConditions.join(' AND ')}
    `

    return this.query<T>(sql, values)
  }

  async delete<T = any>(table: string, where: Record<string, any>): Promise<QueryResult<T>> {
    const conditions: string[] = []
    const values: any[] = []

    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        conditions.push(`${this.sanitizeMySQLIdentifier(key)} IS NULL`)
      } else {
        conditions.push(`${this.sanitizeMySQLIdentifier(key)} = ?`)
        values.push(value)
      }
    }

    const sql = `
      DELETE FROM ${this.sanitizeMySQLIdentifier(table)}
      WHERE ${conditions.join(' AND ')}
    `

    return this.query<T>(sql, values)
  }

  async getSchema(schema?: string): Promise<SchemaInfo> {
    const database = schema || this.config.connection.database

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
    const database = schema || this.config.connection.database
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
    const database = schema || this.config.connection.database

    const query = `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as max_length,
        NUMERIC_PRECISION as precision,
        NUMERIC_SCALE as scale,
        COLUMN_COMMENT as comment,
        EXTRA as extra
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
      precision: number | null
      scale: number | null
      comment: string | null
      extra: string
    }>(query, [database, table])

    return result.data.map(row => ({
      name: row.column_name,
      type: this.formatColumnType(row),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      autoIncrement: row.extra.includes('auto_increment'),
      comment: row.comment || undefined
    }))
  }

  async tableExists(table: string, schema?: string): Promise<boolean> {
    const database = schema || this.config.connection.database

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

  async inTransaction(transaction: PoolConnection, callback: () => Promise<any>): Promise<any> {
    try {
      const result = await callback()
      await this.commit(transaction)
      return result
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }

  async *stream<T = any>(
    sql: string,
    params?: any[],
    options?: { highWaterMark?: number }
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

  private formatColumnType(column: any): string {
    let type = column.data_type

    if (column.max_length && ['varchar', 'char'].includes(column.data_type)) {
      type += `(${column.max_length})`
    } else if (column.precision && ['decimal', 'numeric'].includes(column.data_type)) {
      type += `(${column.precision}`
      if (column.scale) {
        type += `,${column.scale}`
      }
      type += ')'
    }

    return type
  }
}
// @ts-nocheck
