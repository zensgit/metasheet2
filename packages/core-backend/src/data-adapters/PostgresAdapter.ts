// @ts-nocheck
import { Pool, Client, QueryResult as PgQueryResult } from 'pg'
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

export class PostgresAdapter extends BaseDataAdapter {
  private pool: Pool | null = null

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }

    try {
      this.pool = new Pool({
        host: this.config.connection.host,
        port: this.config.connection.port || 5432,
        database: this.config.connection.database,
        user: this.config.credentials?.username,
        password: this.config.credentials?.password,
        ssl: this.config.connection.ssl,
        max: this.config.poolConfig?.max || 20,
        min: this.config.poolConfig?.min || 2,
        idleTimeoutMillis: this.config.poolConfig?.idleTimeout || 10000,
        connectionTimeoutMillis: this.config.poolConfig?.acquireTimeout || 30000
      })

      // Test connection
      await this.pool.query('SELECT 1')
      this.connected = true
      await this.onConnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to connect to PostgreSQL: ${error}`)
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
      throw new Error(`Failed to disconnect from PostgreSQL: ${error}`)
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
      const result = await this.pool.query('SELECT NOW()')
      return result.rows.length > 0
    } catch {
      return false
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    try {
      const result = await this.pool.query(sql, params)

      return {
        data: result.rows,
        metadata: {
          totalCount: result.rowCount || 0,
          columns: result.fields?.map(field => ({
            name: field.name,
            type: this.mapPostgresType(field.dataTypeID),
            nullable: true // PostgreSQL doesn't provide this info in query results
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
      ? options.select.map(col => this.sanitizeIdentifier(col)).join(', ')
      : '*'

    let sql = `SELECT ${selectClause} FROM ${this.sanitizeIdentifier(table)}`
    let params: any[] = []

    // Add joins
    if (options.joins?.length) {
      for (const join of options.joins) {
        const joinType = join.type?.toUpperCase() || 'INNER'
        sql += ` ${joinType} JOIN ${this.sanitizeIdentifier(join.table)} ON ${join.on}`
      }
    }

    // Add where clause
    if (options.where && Object.keys(options.where).length > 0) {
      const whereClause = this.buildWhereClause(options.where)
      sql += ` ${whereClause.sql}`
      params = whereClause.params
    }

    // Add order by
    if (options.orderBy?.length) {
      const orderClauses = options.orderBy.map(
        order => `${this.sanitizeIdentifier(order.column)} ${order.direction.toUpperCase()}`
      )
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    // Add limit and offset
    if (options.limit) {
      sql += ` LIMIT ${options.limit}`
    }
    if (options.offset) {
      sql += ` OFFSET ${options.offset}`
    }

    return this.query<T>(sql, params)
  }

  async insert<T = any>(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>> {
    const records = Array.isArray(data) ? data : [data]
    if (records.length === 0) {
      return { data: [] }
    }

    const columns = Object.keys(records[0])
    const sanitizedColumns = columns.map(col => this.sanitizeIdentifier(col))

    const values: any[] = []
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

    const sql = `
      INSERT INTO ${this.sanitizeIdentifier(table)} (${sanitizedColumns.join(', ')})
      VALUES ${valuePlaceholders.join(', ')}
      RETURNING *
    `

    return this.query<T>(sql, values)
  }

  async update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>> {
    const setClause: string[] = []
    const values: any[] = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(data)) {
      setClause.push(`${this.sanitizeIdentifier(key)} = $${paramIndex++}`)
      values.push(value)
    }

    const whereClause = this.buildWhereClause(where)

    // Adjust parameter indices for where clause
    const adjustedWhereClause = whereClause.sql.replace(/\$(\d+)/g, (match, p1) => {
      return `$${parseInt(p1) + values.length}`
    })

    const sql = `
      UPDATE ${this.sanitizeIdentifier(table)}
      SET ${setClause.join(', ')}
      ${adjustedWhereClause}
      RETURNING *
    `

    return this.query<T>(sql, [...values, ...whereClause.params])
  }

  async delete<T = any>(table: string, where: Record<string, any>): Promise<QueryResult<T>> {
    const whereClause = this.buildWhereClause(where)

    const sql = `
      DELETE FROM ${this.sanitizeIdentifier(table)}
      ${whereClause.sql}
      RETURNING *
    `

    return this.query<T>(sql, whereClause.params)
  }

  async getSchema(schema: string = 'public'): Promise<SchemaInfo> {
    const tablesQuery = `
      SELECT
        t.table_name,
        t.table_schema
      FROM information_schema.tables t
      WHERE t.table_schema = $1
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name
    `

    const viewsQuery = `
      SELECT
        v.table_name as view_name,
        v.table_schema as view_schema,
        v.view_definition
      FROM information_schema.views v
      WHERE v.table_schema = $1
      ORDER BY v.table_name
    `

    const [tablesResult, viewsResult] = await Promise.all([
      this.query<{ table_name: string; table_schema: string }>(tablesQuery, [schema]),
      this.query<{ view_name: string; view_schema: string; view_definition: string }>(viewsQuery, [schema])
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

  async getTableInfo(table: string, schema: string = 'public'): Promise<TableInfo> {
    const columns = await this.getColumns(table, schema)

    // Get primary key info
    const pkQuery = `
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary
        AND c.relname = $1
        AND n.nspname = $2
    `

    const pkResult = await this.query<{ column_name: string }>(pkQuery, [table, schema])
    const primaryKey = pkResult.data.map(row => row.column_name)

    // Get indexes
    const indexQuery = `
      SELECT
        i.relname as index_name,
        idx.indisunique as is_unique,
        array_agg(a.attname ORDER BY a.attnum) as columns
      FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_index idx ON idx.indrelid = t.oid
      JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(idx.indkey)
      WHERE t.relname = $1
        AND n.nspname = $2
        AND NOT idx.indisprimary
      GROUP BY i.relname, idx.indisunique
    `

    const indexResult = await this.query<{ index_name: string; is_unique: boolean; columns: string[] }>(
      indexQuery,
      [table, schema]
    )

    const indexes: IndexInfo[] = indexResult.data.map(row => ({
      name: row.index_name,
      columns: row.columns,
      unique: row.is_unique
    }))

    // Get foreign keys
    const fkQuery = `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column,
        rc.update_rule,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
        AND tc.table_schema = $2
    `

    const fkResult = await this.query<{
      constraint_name: string
      column_name: string
      referenced_table: string
      referenced_column: string
      update_rule: string
      delete_rule: string
    }>(fkQuery, [table, schema])

    const foreignKeys: ForeignKeyInfo[] = fkResult.data.map(row => ({
      name: row.constraint_name,
      column: row.column_name,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
      onUpdate: row.update_rule as any,
      onDelete: row.delete_rule as any
    }))

    return {
      name: table,
      schema,
      columns,
      primaryKey,
      indexes,
      foreignKeys
    }
  }

  async getColumns(table: string, schema: string = 'public'): Promise<ColumnInfo[]> {
    const query = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        col_description(pgc.oid, c.ordinal_position) as comment
      FROM information_schema.columns c
      JOIN pg_class pgc ON pgc.relname = c.table_name
      JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace AND pgn.nspname = c.table_schema
      WHERE c.table_name = $1
        AND c.table_schema = $2
      ORDER BY c.ordinal_position
    `

    const result = await this.query<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      character_maximum_length: number | null
      numeric_precision: number | null
      numeric_scale: number | null
      comment: string | null
    }>(query, [table, schema])

    return result.data.map(row => ({
      name: row.column_name,
      type: this.formatColumnType(row),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      comment: row.comment || undefined
    }))
  }

  async tableExists(table: string, schema: string = 'public'): Promise<boolean> {
    const query = `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
      ) as exists
    `

    const result = await this.query<{ exists: boolean }>(query, [schema, table])
    return result.data[0]?.exists || false
  }

  async beginTransaction(): Promise<Client> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    const client = await this.pool.connect()
    await client.query('BEGIN')
    return client
  }

  async commit(transaction: Client): Promise<void> {
    try {
      await transaction.query('COMMIT')
    } finally {
      transaction.release()
    }
  }

  async rollback(transaction: Client): Promise<void> {
    try {
      await transaction.query('ROLLBACK')
    } finally {
      transaction.release()
    }
  }

  async inTransaction(transaction: Client, callback: () => Promise<any>): Promise<any> {
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
    options?: { highWaterMark?: number; objectMode?: boolean }
  ): AsyncIterableIterator<T> {
    if (!this.pool) {
      throw new Error('Not connected to database')
    }

    const client = await this.pool.connect()

    try {
      const query = client.query(sql, params)

      for await (const row of query) {
        yield row as T
      }
    } finally {
      client.release()
    }
  }

  private mapPostgresType(oid: number): string {
    const typeMap: Record<number, string> = {
      16: 'boolean',
      20: 'bigint',
      21: 'smallint',
      23: 'integer',
      25: 'text',
      700: 'float',
      701: 'double',
      1043: 'varchar',
      1082: 'date',
      1083: 'time',
      1114: 'timestamp',
      1184: 'timestamptz',
      1700: 'numeric',
      3802: 'jsonb'
    }

    return typeMap[oid] || 'unknown'
  }

  private formatColumnType(column: any): string {
    let type = column.data_type

    if (column.character_maximum_length) {
      type += `(${column.character_maximum_length})`
    } else if (column.numeric_precision) {
      type += `(${column.numeric_precision}`
      if (column.numeric_scale) {
        type += `,${column.numeric_scale}`
      }
      type += ')'
    }

    return type
  }
}
// @ts-nocheck
