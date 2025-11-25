/**
 * Database adapter for EventBusService
 * Provides Kysely instance for type-safe database queries
 */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
// Create pg pool
const connectionString = process.env.DATABASE_URL || '';
const pool = connectionString
    ? new Pool({ connectionString })
    : undefined;
// Create Kysely instance with PostgreSQL dialect
export const db = pool ? new Kysely({
    dialect: new PostgresDialect({
        pool: pool
    })
}) : undefined;
// Export pool for direct access if needed
export { pool };
//# sourceMappingURL=db.js.map