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
import { sql } from 'kysely';
/**
 * Logger for migration operations
 */
const log = {
    info: (message) => console.log(`[Migration Pattern] ${message}`),
    warn: (message) => console.warn(`[Migration Pattern] ⚠️ ${message}`),
    error: (message) => console.error(`[Migration Pattern] ❌ ${message}`),
    success: (message) => console.log(`[Migration Pattern] ✅ ${message}`)
};
/**
 * Helper function to check if a column exists (for Kysely < 0.29.0)
 */
export async function checkColumnExists(db, tableName, columnName) {
    const result = await db.selectFrom(sql `information_schema.columns`.as('columns'))
        .select(sql `count(*)`.as('count'))
        .where('table_name', '=', tableName)
        .where('column_name', '=', columnName)
        .executeTakeFirst();
    return result ? parseInt(result.count, 10) > 0 : false;
}
/**
 * Helper function to check if a table exists (for Kysely < 0.29.0)
 */
export async function checkTableExists(db, tableName) {
    const result = await db.selectFrom(sql `information_schema.tables`.as('tables'))
        .select(sql `count(*)`.as('count'))
        .where('table_name', '=', tableName)
        .executeTakeFirst();
    return result ? parseInt(result.count, 10) > 0 : false;
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
export async function addColumnIfNotExists(db, tableName, columnName, columnType, options = {}) {
    try {
        // Check if column exists
        const hasColumn = await checkColumnExists(db, tableName, columnName);
        if (hasColumn) {
            log.info(`Column ${tableName}.${columnName} already exists, skipping`);
            return;
        }
        log.info(`Adding column ${tableName}.${columnName}`);
        // Build ALTER TABLE statement
        let alterTable = db.schema.alterTable(tableName).addColumn(columnName, columnType, (col) => {
            let builder = col;
            if (options.notNull) {
                builder = builder.notNull();
            }
            if (options.unique) {
                builder = builder.unique();
            }
            if (options.defaultTo !== undefined) {
                if (typeof options.defaultTo === 'string' && options.defaultTo.startsWith('sql:')) {
                    // SQL expression
                    builder = builder.defaultTo(sql.raw(options.defaultTo.slice(4)));
                }
                else {
                    // Literal value
                    builder = builder.defaultTo(options.defaultTo);
                }
            }
            if (options.references) {
                builder = builder.references(`${options.references.table}.${options.references.column}`);
                if (options.references.onDelete) {
                    builder = builder.onDelete(options.references.onDelete);
                }
                if (options.references.onUpdate) {
                    builder = builder.onUpdate(options.references.onUpdate);
                }
            }
            return builder;
        });
        await alterTable.execute();
        log.success(`Column ${tableName}.${columnName} added successfully`);
    }
    catch (error) {
        log.error(`Failed to add column ${tableName}.${columnName}: ${error}`);
        throw error;
    }
}
/**
 * Drop a column from a table if it exists
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param columnName - Name of the column to drop
 */
export async function dropColumnIfExists(db, tableName, columnName) {
    try {
        const hasColumn = await checkColumnExists(db, tableName, columnName);
        if (!hasColumn) {
            log.info(`Column ${tableName}.${columnName} does not exist, skipping drop`);
            return;
        }
        log.info(`Dropping column ${tableName}.${columnName}`);
        await db.schema.alterTable(tableName).dropColumn(columnName).execute();
        log.success(`Column ${tableName}.${columnName} dropped successfully`);
    }
    catch (error) {
        log.error(`Failed to drop column ${tableName}.${columnName}: ${error}`);
        throw error;
    }
}
/**
 * Create an index if it doesn't already exist
 *
 * @param db - Kysely database instance
 * @param indexName - Name of the index
 * @param tableName - Name of the table
 * @param columns - Column(s) to index (string or array)
 * @param options - Index options
 */
export async function createIndexIfNotExists(db, indexName, tableName, columns, options = {}) {
    try {
        // Check if index exists (PostgreSQL specific)
        const result = await sql `
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = ${tableName}
        AND indexname = ${indexName}
      ) as exists
    `.execute(db);
        const indexExists = result.rows[0]?.exists;
        if (indexExists) {
            log.info(`Index ${indexName} already exists, skipping`);
            return;
        }
        log.info(`Creating index ${indexName} on ${tableName}`);
        let indexBuilder = db.schema.createIndex(indexName).on(tableName);
        if (options.unique) {
            indexBuilder = indexBuilder.unique();
        }
        if (typeof columns === 'string') {
            indexBuilder = indexBuilder.column(columns);
        }
        else {
            indexBuilder = indexBuilder.columns(columns);
        }
        if (options.where) {
            indexBuilder = indexBuilder.where(options.where);
        }
        if (options.using) {
            indexBuilder = indexBuilder.using(options.using);
        }
        await indexBuilder.execute();
        log.success(`Index ${indexName} created successfully`);
    }
    catch (error) {
        log.error(`Failed to create index ${indexName}: ${error}`);
        throw error;
    }
}
/**
 * Drop an index if it exists
 *
 * @param db - Kysely database instance
 * @param indexName - Name of the index
 */
export async function dropIndexIfExists(db, indexName) {
    try {
        // Check if index exists
        const result = await sql `
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = ${indexName}
      ) as exists
    `.execute(db);
        const indexExists = result.rows[0]?.exists;
        if (!indexExists) {
            log.info(`Index ${indexName} does not exist, skipping drop`);
            return;
        }
        log.info(`Dropping index ${indexName}`);
        await db.schema.dropIndex(indexName).execute();
        log.success(`Index ${indexName} dropped successfully`);
    }
    catch (error) {
        log.error(`Failed to drop index ${indexName}: ${error}`);
        throw error;
    }
}
/**
 * Rename a column if the old name exists and new name doesn't
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param oldColumnName - Current column name
 * @param newColumnName - New column name
 */
export async function renameColumnIfExists(db, tableName, oldColumnName, newColumnName) {
    try {
        const hasOldColumn = await checkColumnExists(db, tableName, oldColumnName);
        const hasNewColumn = await checkColumnExists(db, tableName, newColumnName);
        if (!hasOldColumn) {
            log.info(`Column ${tableName}.${oldColumnName} does not exist, skipping rename`);
            return;
        }
        if (hasNewColumn) {
            log.warn(`Column ${tableName}.${newColumnName} already exists, skipping rename from ${oldColumnName}`);
            return;
        }
        log.info(`Renaming column ${tableName}.${oldColumnName} to ${newColumnName}`);
        await db.schema.alterTable(tableName).renameColumn(oldColumnName, newColumnName).execute();
        log.success(`Column renamed successfully: ${oldColumnName} → ${newColumnName}`);
    }
    catch (error) {
        log.error(`Failed to rename column ${tableName}.${oldColumnName}: ${error}`);
        throw error;
    }
}
/**
 * Migrate data in batches with error handling
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param transformFn - Function to transform each batch of rows
 * @param options - Migration options
 */
export async function migrateDataSafely(db, tableName, transformFn, options = {}) {
    const { batchSize = 1000, whereClause, dryRun = false } = options;
    try {
        log.info(`Starting data migration for ${tableName} (batch size: ${batchSize})`);
        // Count total rows
        let countQuery = db.selectFrom(tableName).select(db.fn.count('id').as('count'));
        if (whereClause) {
            countQuery = countQuery.where(whereClause);
        }
        const countResult = await countQuery.executeTakeFirst();
        const totalRows = Number(countResult?.count || 0);
        if (totalRows === 0) {
            log.info(`No rows to migrate in ${tableName}`);
            return;
        }
        log.info(`Total rows to migrate: ${totalRows}`);
        let offset = 0;
        let migratedCount = 0;
        let errorCount = 0;
        while (offset < totalRows) {
            log.info(`Processing batch: ${offset} - ${offset + batchSize} of ${totalRows}`);
            // Fetch batch
            let selectQuery = db.selectFrom(tableName).selectAll().limit(batchSize).offset(offset);
            if (whereClause) {
                selectQuery = selectQuery.where(whereClause);
            }
            const batch = await selectQuery.execute();
            if (batch.length === 0)
                break;
            try {
                // Transform batch
                const transformedBatch = await transformFn(batch);
                if (!dryRun) {
                    // Update batch
                    for (const row of transformedBatch) {
                        await db
                            .updateTable(tableName)
                            .set(row)
                            .where('id', '=', row.id)
                            .execute();
                    }
                }
                migratedCount += batch.length;
            }
            catch (error) {
                log.error(`Error processing batch at offset ${offset}: ${error}`);
                errorCount += batch.length;
            }
            offset += batchSize;
        }
        if (dryRun) {
            log.info(`[DRY RUN] Would have migrated ${migratedCount} rows`);
        }
        else {
            log.success(`Data migration complete: ${migratedCount} rows migrated, ${errorCount} errors`);
        }
    }
    catch (error) {
        log.error(`Data migration failed for ${tableName}: ${error}`);
        throw error;
    }
}
/**
 * Create a table with standard columns and best practices
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 * @param buildColumns - Function to define table columns
 * @param options - Table options
 */
export async function createTableWithDefaults(db, tableName, buildColumns, options = {}) {
    const { withTimestamps = true, withSoftDelete = false } = options;
    try {
        const tableExists = await checkTableExists(db, tableName);
        if (tableExists) {
            log.info(`Table ${tableName} already exists, skipping creation`);
            return;
        }
        log.info(`Creating table ${tableName}`);
        let createTable = db.schema
            .createTable(tableName)
            .ifNotExists()
            .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql `gen_random_uuid()::text`));
        // Add custom columns
        createTable = buildColumns(createTable);
        // Add timestamps
        if (withTimestamps) {
            createTable = createTable
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql `NOW()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql `NOW()`));
        }
        // Add soft delete
        if (withSoftDelete) {
            createTable = createTable.addColumn('deleted_at', 'timestamptz');
        }
        await createTable.execute();
        // Create updated_at trigger
        if (withTimestamps) {
            await createUpdatedAtTrigger(db, tableName);
        }
        log.success(`Table ${tableName} created successfully`);
    }
    catch (error) {
        log.error(`Failed to create table ${tableName}: ${error}`);
        throw error;
    }
}
/**
 * Create trigger to automatically update updated_at column
 *
 * @param db - Kysely database instance
 * @param tableName - Name of the table
 */
export async function createUpdatedAtTrigger(db, tableName) {
    try {
        // Create trigger function (idempotent)
        await sql `
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db);
        // Create trigger
        await sql `
      DROP TRIGGER IF EXISTS trigger_${sql.raw(tableName)}_updated_at ON ${sql.table(tableName)};
      CREATE TRIGGER trigger_${sql.raw(tableName)}_updated_at
      BEFORE UPDATE ON ${sql.table(tableName)}
      FOR EACH ROW
      EXECUTE FUNCTION update_timestamp();
    `.execute(db);
        log.success(`Updated_at trigger created for ${tableName}`);
    }
    catch (error) {
        log.error(`Failed to create updated_at trigger for ${tableName}: ${error}`);
        throw error;
    }
}
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
export async function addForeignKeyIfNotExists(db, constraintName, tableName, columnName, refTable, refColumn, options = {}) {
    try {
        // Check if constraint exists
        const result = await sql `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = ${constraintName}
        AND table_name = ${tableName}
      ) as exists
    `.execute(db);
        const constraintExists = result.rows[0]?.exists;
        if (constraintExists) {
            log.info(`Foreign key ${constraintName} already exists, skipping`);
            return;
        }
        log.info(`Adding foreign key ${constraintName} to ${tableName}.${columnName}`);
        let constraint = db.schema
            .alterTable(tableName)
            .addForeignKeyConstraint(constraintName, [columnName], refTable, [refColumn]);
        if (options.onDelete) {
            constraint = constraint.onDelete(options.onDelete);
        }
        if (options.onUpdate) {
            constraint = constraint.onUpdate(options.onUpdate);
        }
        await constraint.execute();
        log.success(`Foreign key ${constraintName} added successfully`);
    }
    catch (error) {
        log.error(`Failed to add foreign key ${constraintName}: ${error}`);
        throw error;
    }
}
//# sourceMappingURL=_patterns.js.map