// @ts-nocheck
/**
 * Base Repository Pattern Implementation
 * Provides common CRUD operations for all entities
 */

import type { Kysely, Insertable, Selectable, Updateable } from 'kysely'
import type { Database } from '../types'
import { db, transaction } from '../kysely'

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
    return await this.db
      .selectFrom(this.tableName)
      .selectAll()
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
    let query = this.db.selectFrom(this.tableName).selectAll()

    if (options?.where) {
      for (const [key, value] of Object.entries(options.where)) {
        query = query.where(key as any, '=', value as any)
      }
    }

    if (options?.orderBy) {
      query = query.orderBy(
        options.orderBy.column as any,
        options.orderBy.order || 'asc'
      )
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
    let query = this.db.selectFrom(this.tableName).selectAll()

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key as any, '=', value as any)
    }

    return await query.executeTakeFirst() as TSelect | undefined
  }

  /**
   * Count records matching conditions
   */
  async count(where?: Partial<TSelect>): Promise<number> {
    let query = this.db
      .selectFrom(this.tableName)
      .select(this.db.fn.count('id').as('count'))

    if (where) {
      for (const [key, value] of Object.entries(where)) {
        query = query.where(key as any, '=', value as any)
      }
    }

    const result = await query.executeTakeFirst()
    return Number(result?.count || 0)
  }

  /**
   * Create new record
   */
  async create(data: TInsert): Promise<TSelect> {
    const result = await this.db
      .insertInto(this.tableName)
      .values(data as any)
      .returningAll()
      .executeTakeFirstOrThrow()

    return result as TSelect
  }

  /**
   * Create multiple records
   */
  async createMany(data: TInsert[]): Promise<TSelect[]> {
    if (data.length === 0) return []

    const results = await this.db
      .insertInto(this.tableName)
      .values(data as any)
      .returningAll()
      .execute()

    return results as TSelect[]
  }

  /**
   * Update record by ID
   */
  async update(id: string, data: TUpdate): Promise<TSelect | undefined> {
    const result = await this.db
      .updateTable(this.tableName)
      .set(data as any)
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
    let query = this.db.updateTable(this.tableName).set(data as any)

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key as any, '=', value as any)
    }

    const result = await query.execute()
    return result.length
  }

  /**
   * Delete record by ID
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom(this.tableName)
      .where('id', '=', id)
      .execute()

    return result.length > 0
  }

  /**
   * Delete multiple records
   */
  async deleteMany(where: Partial<TSelect>): Promise<number> {
    let query = this.db.deleteFrom(this.tableName)

    for (const [key, value] of Object.entries(where)) {
      query = query.where(key as any, '=', value as any)
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
// @ts-nocheck
