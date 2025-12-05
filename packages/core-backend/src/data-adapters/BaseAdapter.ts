import { EventEmitter } from 'eventemitter3'

// Type for connection pool (varies by adapter implementation)
export type ConnectionPool = unknown

// Type for transaction objects (varies by adapter implementation)
export type Transaction = unknown

// Generic type for database values (can include null for database NULL values)
export type DbValue = string | number | boolean | null | Date | Buffer | DbValue[] | { [key: string]: DbValue }

// Type for configuration values (non-nullable primitive values for config)
export type ConfigValue = string | number | boolean | Date | ConfigValue[] | { [key: string]: ConfigValue }

// Type for connection configuration (uses ConfigValue which excludes null)
export type ConnectionConfig = Record<string, ConfigValue>

// Type for adapter options
export type AdapterOptions = Record<string, ConfigValue>

// Type for credentials
export type Credentials = Record<string, ConfigValue>

// Type for where operators
export interface WhereOperators {
  $gt?: DbValue
  $gte?: DbValue
  $lt?: DbValue
  $lte?: DbValue
  $ne?: DbValue
  $like?: string
  $ilike?: string
  $in?: DbValue[]
  $nin?: DbValue[]
  $between?: [DbValue, DbValue]
}

// Type for where clause values
export type WhereValue = DbValue | WhereOperators

export interface DataSourceConfig {
  id: string
  name: string
  type: string
  connection: ConnectionConfig
  options?: AdapterOptions
  credentials?: Credentials
  poolConfig?: {
    min?: number
    max?: number
    idleTimeout?: number
    acquireTimeout?: number
  }
}

export interface QueryOptions {
  limit?: number
  offset?: number
  orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>
  where?: Record<string, WhereValue>
  select?: string[]
  joins?: Array<{
    table: string
    on: string
    type?: 'inner' | 'left' | 'right' | 'full'
  }>
  raw?: boolean
}

export interface QueryResult<T = Record<string, DbValue>> {
  data: T[]
  metadata?: {
    totalCount?: number
    pageCount?: number
    currentPage?: number
    columns?: Array<{
      name: string
      type: string
      nullable?: boolean
    }>
  }
  error?: Error
}

export interface SchemaInfo {
  tables: TableInfo[]
  views?: ViewInfo[]
  procedures?: ProcedureInfo[]
}

export interface TableInfo {
  name: string
  schema?: string
  columns: ColumnInfo[]
  primaryKey?: string[]
  indexes?: IndexInfo[]
  foreignKeys?: ForeignKeyInfo[]
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue?: DbValue
  primaryKey?: boolean
  autoIncrement?: boolean
  comment?: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  type?: string
}

export interface ForeignKeyInfo {
  name: string
  column: string
  referencedTable: string
  referencedColumn: string
  onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION'
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION'
}

export interface ViewInfo {
  name: string
  schema?: string
  definition?: string
  columns: ColumnInfo[]
}

export interface ProcedureInfo {
  name: string
  schema?: string
  parameters?: Array<{
    name: string
    type: string
    direction: 'IN' | 'OUT' | 'INOUT'
  }>
}

// Type guard functions
export function isString(value: ConfigValue | undefined): value is string {
  return typeof value === 'string'
}

export function isNumber(value: ConfigValue | undefined): value is number {
  return typeof value === 'number'
}

export function isBoolean(value: ConfigValue | undefined): value is boolean {
  return typeof value === 'boolean'
}

// Type guard for WhereOperators
function isWhereOperator(value: WhereValue): value is WhereOperators {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  return keys.length > 0 && keys.some(key => key.startsWith('$'))
}

// Helper functions to safely access config values
export function getStringConfig(value: ConfigValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

export function getNumberConfig(value: ConfigValue | undefined): number | undefined {
  return isNumber(value) ? value : undefined
}

export function getBooleanConfig(value: ConfigValue | undefined): boolean | undefined {
  return isBoolean(value) ? value : undefined
}

export abstract class BaseDataAdapter extends EventEmitter {
  protected config: DataSourceConfig
  protected connected: boolean = false
  protected pool: ConnectionPool

  constructor(config: DataSourceConfig) {
    super()
    this.config = config
  }

  // Connection management
  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract isConnected(): boolean
  abstract testConnection(): Promise<boolean>

  // Query execution
  abstract query<T = Record<string, DbValue>>(sql: string, params?: DbValue[]): Promise<QueryResult<T>>
  abstract select<T = Record<string, DbValue>>(table: string, options?: QueryOptions): Promise<QueryResult<T>>
  abstract insert<T = Record<string, DbValue>>(table: string, data: Record<string, DbValue> | Record<string, DbValue>[]): Promise<QueryResult<T>>
  abstract update<T = Record<string, DbValue>>(table: string, data: Record<string, DbValue>, where: Record<string, WhereValue>): Promise<QueryResult<T>>
  abstract delete<T = Record<string, DbValue>>(table: string, where: Record<string, WhereValue>): Promise<QueryResult<T>>

  // Schema operations
  abstract getSchema(schema?: string): Promise<SchemaInfo>
  abstract getTableInfo(table: string, schema?: string): Promise<TableInfo>
  abstract getColumns(table: string, schema?: string): Promise<ColumnInfo[]>
  abstract tableExists(table: string, schema?: string): Promise<boolean>

  // Transaction support
  abstract beginTransaction(): Promise<Transaction>
  abstract commit(transaction: Transaction): Promise<void>
  abstract rollback(transaction: Transaction): Promise<void>
  abstract inTransaction<R = unknown>(transaction: Transaction, callback: () => Promise<R>): Promise<R>

  // Batch operations
  async batchInsert<T = Record<string, DbValue>>(
    table: string,
    data: Record<string, DbValue>[],
    batchSize: number = 1000
  ): Promise<QueryResult<T>[]> {
    const results: QueryResult<T>[] = []

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize)
      const result = await this.insert<T>(table, batch)
      results.push(result)
    }

    return results
  }

  // Streaming support
  abstract stream<T = Record<string, DbValue>>(
    sql: string,
    params?: DbValue[],
    options?: {
      highWaterMark?: number
      objectMode?: boolean
    }
  ): AsyncIterableIterator<T>

  // Helper methods
  protected sanitizeIdentifier(identifier: string): string {
    // Remove or escape potentially dangerous characters
    return identifier.replace(/[^a-zA-Z0-9_]/g, '')
  }

  protected buildWhereClause(where: Record<string, WhereValue>): { sql: string; params: DbValue[] } {
    const conditions: string[] = []
    const params: DbValue[] = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        conditions.push(`${this.sanitizeIdentifier(key)} IS NULL`)
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => `$${paramIndex++}`).join(', ')
        conditions.push(`${this.sanitizeIdentifier(key)} IN (${placeholders})`)
        params.push(...value)
      } else if (isWhereOperator(value)) {
        // Handle operators like { $gt: 5, $lt: 10 }
        for (const [op, val] of Object.entries(value)) {
          if (val !== undefined) {
            const operator = this.getOperator(op)
            conditions.push(`${this.sanitizeIdentifier(key)} ${operator} $${paramIndex++}`)
            params.push(val)
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        // Handle nested objects as JSON equality
        conditions.push(`${this.sanitizeIdentifier(key)} = $${paramIndex++}`)
        params.push(value)
      } else {
        conditions.push(`${this.sanitizeIdentifier(key)} = $${paramIndex++}`)
        params.push(value)
      }
    }

    return {
      sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params
    }
  }

  protected getOperator(op: string): string {
    const operators: Record<string, string> = {
      $gt: '>',
      $gte: '>=',
      $lt: '<',
      $lte: '<=',
      $ne: '!=',
      $like: 'LIKE',
      $ilike: 'ILIKE',
      $in: 'IN',
      $nin: 'NOT IN',
      $between: 'BETWEEN'
    }
    return operators[op] || '='
  }

  // Lifecycle hooks
  protected async onConnect(): Promise<void> {
    this.emit('connected', { adapter: this.config.name })
  }

  protected async onDisconnect(): Promise<void> {
    this.emit('disconnected', { adapter: this.config.name })
  }

  protected async onError(error: Error): Promise<void> {
    this.emit('error', { adapter: this.config.name, error })
  }

  // Utility methods
  async ping(): Promise<boolean> {
    try {
      return await this.testConnection()
    } catch (error) {
      return false
    }
  }

  getConfig(): DataSourceConfig {
    return { ...this.config }
  }

  getName(): string {
    return this.config.name
  }

  getType(): string {
    return this.config.type
  }
}
