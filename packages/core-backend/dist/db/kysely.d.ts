/**
 * Unified Kysely Database Configuration
 * Central database connection and type-safe query builder
 */
import { Kysely } from 'kysely';
import type { Database } from './types';
export declare const db: Kysely<Database>;
export type KyselyDB = typeof db;
/**
 * Transaction helper
 */
export declare function transaction<T>(callback: (trx: Kysely<Database>) => Promise<T>): Promise<T>;
/**
 * Database health check
 */
export declare function checkHealth(): Promise<{
    connected: boolean;
    pool?: {
        total: number;
        idle: number;
        waiting: number;
    };
    error?: string;
}>;
/**
 * Graceful shutdown
 */
export declare function closeDatabase(): Promise<void>;
/**
 * Query builder helpers
 */
export declare const qb: {
    /**
     * Build a dynamic where clause
     */
    dynamicWhere<T extends keyof Database>(query: any, conditions: Record<string, any>): any;
    /**
     * Apply pagination
     */
    paginate<T extends keyof Database>(query: any, page?: number, limit?: number): any;
    /**
     * Apply sorting
     */
    orderBy<T extends keyof Database>(query: any, sortBy?: string, order?: "asc" | "desc"): any;
};
export default db;
export type { Database } from './types';
//# sourceMappingURL=kysely.d.ts.map