/**
 * Migration Pattern Library
 *
 * Purpose: Reusable migration helpers for common operations
 * Benefits:
 * - Idempotent operations by default
 * - Consistent error handling
 * - Reduced boilerplate code
 * - Better migration reliability
 *
 * Usage:
 * ```typescript
 * import { Kysely } from 'kysely'
 * import { addColumnIfNotExists, createIndexIfNotExists, migrateDataSafely } from './_patterns'
 *
 * export async function up(db: Kysely<any>): Promise<void> {
 *   // Add column safely
 *   await addColumnIfNotExists(db, 'users', 'email_verified', 'boolean', {
 *     defaultTo: false,
 *     notNull: true
 *   })
 *
 *   // Create index safely
 *   await createIndexIfNotExists(db, 'idx_users_email', 'users', 'email')
 *
 *   // Migrate data safely
 *   await migrateDataSafely(db, 'users', async (batch) => {
 *     // Transform each batch of data
 *     return batch.map(row => ({
 *       ...row,
 *       full_name: `${row.first_name} ${row.last_name}`
 *     }))
 *   })
 * }
 * ```
 */
import { Kysely, RawBuilder } from 'kysely';
/**
 * Helper function to check if a column exists (for Kysely < 0.29.0)
 */
export declare function checkColumnExists(db: Kysely<any>, tableName: string, columnName: string): Promise<boolean>;
/**
 * Helper function to check if a table exists (for Kysely < 0.29.0)
 */
export declare function checkTableExists(db: Kysely<any>, tableName: string): Promise<boolean>;
/**
 * Column Options
 */
interface ColumnOptions {
    notNull?: boolean;
    unique?: boolean;
    defaultTo?: any;
    references?: {
        table: string;
        column: string;
        onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
        onUpdate?: 'cascade' | 'set null' | 'restrict' | 'no action';
    };
}
/**
 * Add a column to a table if it doesn't already exist
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param columnName - Name of the column to add
 * @param columnType - SQL type of the column
 * @param options - Column constraints and options
 */
export declare function addColumnIfNotExists(db: Kysely<any>, tableName: string, columnName: string, columnType: string, options?: ColumnOptions): Promise<void>;
/**
 * Drop a column from a table if it exists
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param columnName - Name of the column to drop
 */
export declare function dropColumnIfExists(db: Kysely<any>, tableName: string, columnName: string): Promise<void>;
/**
 * Create an index if it doesn't already exist
 *
 * @param db - Kysely database instance
 * @param indexName - Name of the index
 * @param tableName - Name of the table
 * @param columns - Column(s) to index (string or array)
 * @param options - Index options
 */
export declare function createIndexIfNotExists(db: Kysely<any>, indexName: string, tableName: string, columns: string | string[], options?: {
    unique?: boolean;
    where?: RawBuilder<any>;
    using?: string;
}): Promise<void>;
/**
 * Drop an index if it exists
 *
 * @param db - Kysely database instance
 * @param indexName - Name of the index
 */
export declare function dropIndexIfExists(db: Kysely<any>, indexName: string): Promise<void>;
/**
 * Rename a column if the old name exists and new name doesn't
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param oldColumnName - Current column name
 * @param newColumnName - New column name
 */
export declare function renameColumnIfExists(db: Kysely<any>, tableName: string, oldColumnName: string, newColumnName: string): Promise<void>;
/**
 * Migrate data in batches with error handling
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param transformFn - Function to transform each batch of rows
 * @param options - Migration options
 */
export declare function migrateDataSafely<T = any>(db: Kysely<any>, tableName: string, transformFn: (batch: T[]) => Promise<T[]> | T[], options?: {
    batchSize?: number;
    whereClause?: any;
    dryRun?: boolean;
}): Promise<void>;
/**
 * Create a table with standard columns and best practices
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param buildColumns - Function to define table columns
 * @param options - Table options
 */
export declare function createTableWithDefaults(db: Kysely<any>, tableName: string, buildColumns: (table: any) => any, options?: {
    withTimestamps?: boolean;
    withSoftDelete?: boolean;
}): Promise<void>;
/**
 * Create trigger to automatically update updated_at column
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 */
export declare function createUpdatedAtTrigger(db: Kysely<any>, tableName: string): Promise<void>;
/**
 * Add foreign key constraint if it doesn't exist
 *
 * @param db - Kysely database instance
 * @param constraintName - Name of the constraint
 * @param tableName - Name of the table
 * @param columnName - Column to add constraint to
 * @param refTable - Referenced table
 * @param refColumn - Referenced column
 * @param options - Constraint options
 */
export declare function addForeignKeyIfNotExists(db: Kysely<any>, constraintName: string, tableName: string, columnName: string, refTable: string, refColumn: string, options?: {
    onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
    onUpdate?: 'cascade' | 'set null' | 'restrict' | 'no action';
}): Promise<void>;
export {};
//# sourceMappingURL=_patterns.d.ts.map