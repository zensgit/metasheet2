import { EventEmitter } from 'eventemitter3'

export interface DataSourceConfig {
  id: string
  name: string
  type: string
  connection: Record<string, any>
  options?: Record<string, any>
  credentials?: Record<string, any>
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
  where?: Record<string, any>
  select?: string[]
  joins?: Array<{
    table: string
    on: string
    type?: 'inner' | 'left' | 'right' | 'full'
  }>
  raw?: boolean
}

export interface QueryResult<T = any> {
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
  defaultValue?: any
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

export abstract class BaseDataAdapter extends EventEmitter {
  protected config: DataSourceConfig
  protected connected: boolean = false
  protected pool: any

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
  abstract query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>
  abstract select<T = any>(table: string, options?: QueryOptions): Promise<QueryResult<T>>
  abstract insert<T = any>(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>
  abstract update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>
  abstract delete<T = any>(table: string, where: Record<string, any>): Promise<QueryResult<T>>

  // Schema operations
  abstract getSchema(schema?: string): Promise<SchemaInfo>
  abstract getTableInfo(table: string, schema?: string): Promise<TableInfo>
  abstract getColumns(table: string, schema?: string): Promise<ColumnInfo[]>
  abstract tableExists(table: string, schema?: string): Promise<boolean>

  // Transaction support
  abstract beginTransaction(): Promise<any>
  abstract commit(transaction: any): Promise<void>
  abstract rollback(transaction: any): Promise<void>
  abstract inTransaction(transaction: any, callback: () => Promise<any>): Promise<any>

  // Batch operations
  async batchInsert<T = any>(
    table: string,
    data: Record<string, any>[],
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
  abstract stream<T = any>(
    sql: string,
    params?: any[],
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

  protected buildWhereClause(where: Record<string, any>): { sql: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        conditions.push(`${this.sanitizeIdentifier(key)} IS NULL`)
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => `$${paramIndex++}`).join(', ')
        conditions.push(`${this.sanitizeIdentifier(key)} IN (${placeholders})`)
        params.push(...value)
      } else if (typeof value === 'object' && value !== null) {
        // Handle operators like { $gt: 5, $lt: 10 }
        for (const [op, val] of Object.entries(value)) {
          const operator = this.getOperator(op)
          conditions.push(`${this.sanitizeIdentifier(key)} ${operator} $${paramIndex++}`)
          params.push(val)
        }
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