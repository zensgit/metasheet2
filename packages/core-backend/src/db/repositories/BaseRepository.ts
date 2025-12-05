/**
 * Base Repository Pattern Implementation
 * Provides common CRUD operations for all entities
 *
 * Note: Uses `any` type assertions in places where Kysely's complex union types
 * (62 tables) cause "union type too complex" TypeScript errors. This is a known
 * limitation when working with large database schemas in Kysely.
 */

import type { Kysely, Insertable, Selectable, Updateable, SelectQueryBuilder, UpdateQueryBuilder, DeleteQueryBuilder } from 'kysely'
import type { Database } from '../types'
import { db, transaction } from '../kysely'

// Type alias for query builders with any - needed due to Kysely's complex union types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySelectQueryBuilder = SelectQueryBuilder<any, any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUpdateQueryBuilder = UpdateQueryBuilder<any, any, any, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDeleteQueryBuilder = DeleteQueryBuilder<any, any, any>

export abstract class BaseRepository<
  TTable extends keyof Database,
  TSelect = Selectable<Database[TTable]>,
  TInsert = Insertable<Database[TTable]>,
  TUpdate = Updateable<Database[TTable]>
> {
  protected db: Kysely<Database>
  protected tableName: TTable

  constructor(tableName: TTable) {
    if (!db) {
      throw new Error('Database not initialized')
    }
    this.db = db
    this.tableName = tableName
  }

  /**
   * Find record by ID
   */
  async findById(id: string): Promise<TSelect | undefined> {
    // Cast to any to avoid Kysely's complex union type errors with dynamic table names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (this.db.selectFrom(this.tableName as any) as any)
      .selectAll() as AnySelectQueryBuilder

    return await query
      .where('id', '=', id)
      .executeTakeFirst() as TSelect | undefined
  }

  /**
   * Find all records with optional filtering
   */
  async findAll(options?: {
    where?: Partial<TSelect>
    limit?: number
    offset?: number
    orderBy?: { column: string; order?: 'asc' | 'desc' }
  }): Promise<TSelect[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.db.selectFrom(this.tableName as any) as any)
      .selectAll() as AnySelectQueryBuilder

    if (options?.where) {
      for (const [key, value] of Object.entries(options.where)) {
        query = query.where(key, '=', value)
      }
    }

    if (options?.orderBy) {
      query = query.orderBy(options.orderBy.column, options.orderBy.order || 'asc')
    }

    if (options?.limit) {
      query = query.limit(options.limit)
    }

    if (options?.offset) {
      query = query.offset(options.offset)
    }

    return await query.execute() as TSelect[]
  }

  /**
   * Find one record matching conditions
   */
  async findOne(where: Partial<TSelect>): Promise<TSelect | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (this.db.selectFrom(this.tableName as any) as any)
      .selectAll() as AnySelectQueryBuilder

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key, '=', value)
    }

    return await query.executeTakeFirst() as TSelect | undefined
  }

  /**
   * Count records matching conditions
   */
  async count(where?: Partial<TSelect>): Promise<number> {
    // Cast early to avoid union type complexity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseQuery = this.db.selectFrom(this.tableName as any) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = baseQuery.select((eb: any) => eb.fn.count('id').as('count')) as AnySelectQueryBuilder

    if (where) {
      for (const [key, value] of Object.entries(where)) {
        query = query.where(key, '=', value)
      }
    }

    const result = await query.executeTakeFirst()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((result as any)?.count || 0)
  }

  /**
   * Create new record
   */
  async create(data: TInsert): Promise<TSelect> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.db.insertInto(this.tableName as any) as any)
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow()

    return result as TSelect
  }

  /**
   * Create multiple records
   */
  async createMany(data: TInsert[]): Promise<TSelect[]> {
    if (data.length === 0) return []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (this.db.insertInto(this.tableName as any) as any)
      .values(data)
      .returningAll()
      .execute()

    return results as TSelect[]
  }

  /**
   * Update record by ID
   */
  async update(id: string, data: TUpdate): Promise<TSelect | undefined> {
    // Cast early to avoid union type complexity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseQuery = this.db.updateTable(this.tableName as any) as any
    const query = baseQuery.set(data) as AnyUpdateQueryBuilder

    const result = await query
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    return result as TSelect | undefined
  }

  /**
   * Update multiple records
   */
  async updateMany(
    where: Partial<TSelect>,
    data: TUpdate
  ): Promise<number> {
    // Cast early to avoid union type complexity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseQuery = this.db.updateTable(this.tableName as any) as any
    let query = baseQuery.set(data) as AnyUpdateQueryBuilder

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key, '=', value)
    }

    const result = await query.execute()
    return result.length
  }

  /**
   * Delete record by ID
   */
  async delete(id: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = this.db.deleteFrom(this.tableName as any) as AnyDeleteQueryBuilder

    const result = await query
      .where('id', '=', id)
      .execute()

    return result.length > 0
  }

  /**
   * Delete multiple records
   */
  async deleteMany(where: Partial<TSelect>): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = this.db.deleteFrom(this.tableName as any) as AnyDeleteQueryBuilder

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key, '=', value)
    }

    const result = await query.execute()
    return result.length
  }

  /**
   * Execute in transaction
   */
  async withTransaction<T>(
    callback: (trx: Kysely<Database>) => Promise<T>
  ): Promise<T> {
    return await transaction(callback)
  }

  /**
   * Check if record exists
   */
  async exists(where: Partial<TSelect>): Promise<boolean> {
    const count = await this.count(where)
    return count > 0
  }

  /**
   * Paginated query
   */
  async paginate(options: {
    page?: number
    limit?: number
    where?: Partial<TSelect>
    orderBy?: { column: string; order?: 'asc' | 'desc' }
  }) {
    const page = options.page || 1
    const limit = options.limit || 20
    const offset = (page - 1) * limit

    const [items, total] = await Promise.all([
      this.findAll({
        where: options.where,
        limit,
        offset,
        orderBy: options.orderBy,
      }),
      this.count(options.where),
    ])

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    }
  }
}
