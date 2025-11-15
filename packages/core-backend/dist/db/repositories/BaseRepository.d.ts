/**
 * Base Repository Pattern Implementation
 * Provides common CRUD operations for all entities
 */
import type { Kysely, Insertable, Selectable, Updateable } from 'kysely';
import type { Database } from '../types';
export declare abstract class BaseRepository<TTable extends keyof Database, TSelect = Selectable<Database[TTable]>, TInsert = Insertable<Database[TTable]>, TUpdate = Updateable<Database[TTable]>> {
    protected db: Kysely<Database>;
    protected tableName: TTable;
    constructor(tableName: TTable);
    /**
     * Find record by ID
     */
    findById(id: string): Promise<TSelect | undefined>;
    /**
     * Find all records with optional filtering
     */
    findAll(options?: {
        where?: Partial<TSelect>;
        limit?: number;
        offset?: number;
        orderBy?: {
            column: string;
            order?: 'asc' | 'desc';
        };
    }): Promise<TSelect[]>;
    /**
     * Find one record matching conditions
     */
    findOne(where: Partial<TSelect>): Promise<TSelect | undefined>;
    /**
     * Count records matching conditions
     */
    count(where?: Partial<TSelect>): Promise<number>;
    /**
     * Create new record
     */
    create(data: TInsert): Promise<TSelect>;
    /**
     * Create multiple records
     */
    createMany(data: TInsert[]): Promise<TSelect[]>;
    /**
     * Update record by ID
     */
    update(id: string, data: TUpdate): Promise<TSelect | undefined>;
    /**
     * Update multiple records
     */
    updateMany(where: Partial<TSelect>, data: TUpdate): Promise<number>;
    /**
     * Delete record by ID
     */
    delete(id: string): Promise<boolean>;
    /**
     * Delete multiple records
     */
    deleteMany(where: Partial<TSelect>): Promise<number>;
    /**
     * Execute in transaction
     */
    withTransaction<T>(callback: (trx: Kysely<Database>) => Promise<T>): Promise<T>;
    /**
     * Check if record exists
     */
    exists(where: Partial<TSelect>): Promise<boolean>;
    /**
     * Paginated query
     */
    paginate(options: {
        page?: number;
        limit?: number;
        where?: Partial<TSelect>;
        orderBy?: {
            column: string;
            order?: 'asc' | 'desc';
        };
    }): Promise<{
        items: TSelect[];
        pagination: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
            hasNext: boolean;
            hasPrev: boolean;
        };
    }>;
}
//# sourceMappingURL=BaseRepository.d.ts.map