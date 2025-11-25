// @ts-nocheck
/**
 * Base Repository Pattern Implementation
 * Provides common CRUD operations for all entities
 */
import { db, transaction } from '../kysely';
export class BaseRepository {
    db;
    tableName;
    constructor(tableName) {
        if (!db) {
            throw new Error('Database not initialized');
        }
        this.db = db;
        this.tableName = tableName;
    }
    /**
     * Find record by ID
     */
    async findById(id) {
        return await this.db
            .selectFrom(this.tableName)
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst();
    }
    /**
     * Find all records with optional filtering
     */
    async findAll(options) {
        let query = this.db.selectFrom(this.tableName).selectAll();
        if (options?.where) {
            for (const [key, value] of Object.entries(options.where)) {
                query = query.where(key, '=', value);
            }
        }
        if (options?.orderBy) {
            query = query.orderBy(options.orderBy.column, options.orderBy.order || 'asc');
        }
        if (options?.limit) {
            query = query.limit(options.limit);
        }
        if (options?.offset) {
            query = query.offset(options.offset);
        }
        return await query.execute();
    }
    /**
     * Find one record matching conditions
     */
    async findOne(where) {
        let query = this.db.selectFrom(this.tableName).selectAll();
        for (const [key, value] of Object.entries(where)) {
            query = query.where(key, '=', value);
        }
        return await query.executeTakeFirst();
    }
    /**
     * Count records matching conditions
     */
    async count(where) {
        let query = this.db
            .selectFrom(this.tableName)
            .select(this.db.fn.count('id').as('count'));
        if (where) {
            for (const [key, value] of Object.entries(where)) {
                query = query.where(key, '=', value);
            }
        }
        const result = await query.executeTakeFirst();
        return Number(result?.count || 0);
    }
    /**
     * Create new record
     */
    async create(data) {
        const result = await this.db
            .insertInto(this.tableName)
            .values(data)
            .returningAll()
            .executeTakeFirstOrThrow();
        return result;
    }
    /**
     * Create multiple records
     */
    async createMany(data) {
        if (data.length === 0)
            return [];
        const results = await this.db
            .insertInto(this.tableName)
            .values(data)
            .returningAll()
            .execute();
        return results;
    }
    /**
     * Update record by ID
     */
    async update(id, data) {
        const result = await this.db
            .updateTable(this.tableName)
            .set(data)
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirst();
        return result;
    }
    /**
     * Update multiple records
     */
    async updateMany(where, data) {
        let query = this.db.updateTable(this.tableName).set(data);
        for (const [key, value] of Object.entries(where)) {
            query = query.where(key, '=', value);
        }
        const result = await query.execute();
        return result.length;
    }
    /**
     * Delete record by ID
     */
    async delete(id) {
        const result = await this.db
            .deleteFrom(this.tableName)
            .where('id', '=', id)
            .execute();
        return result.length > 0;
    }
    /**
     * Delete multiple records
     */
    async deleteMany(where) {
        let query = this.db.deleteFrom(this.tableName);
        for (const [key, value] of Object.entries(where)) {
            query = query.where(key, '=', value);
        }
        const result = await query.execute();
        return result.length;
    }
    /**
     * Execute in transaction
     */
    async withTransaction(callback) {
        return await transaction(callback);
    }
    /**
     * Check if record exists
     */
    async exists(where) {
        const count = await this.count(where);
        return count > 0;
    }
    /**
     * Paginated query
     */
    async paginate(options) {
        const page = options.page || 1;
        const limit = options.limit || 20;
        const offset = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.findAll({
                where: options.where,
                limit,
                offset,
                orderBy: options.orderBy,
            }),
            this.count(options.where),
        ]);
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
        };
    }
}
// @ts-nocheck
//# sourceMappingURL=BaseRepository.js.map