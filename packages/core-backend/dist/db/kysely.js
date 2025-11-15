"use strict";
/**
 * Unified Kysely Database Configuration
 * Central database connection and type-safe query builder
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.qb = exports.db = void 0;
exports.transaction = transaction;
exports.checkHealth = checkHealth;
exports.closeDatabase = closeDatabase;
const kysely_1 = require("kysely");
const pg_1 = require("pg");
// Environment configuration
const config = {
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'metasheet',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        connectionString: process.env.DATABASE_URL,
        // Connection pool settings
        min: parseInt(process.env.DB_POOL_MIN || '2'),
        max: parseInt(process.env.DB_POOL_MAX || '10'),
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000'),
    }
};
// Create connection pool
let pool;
if (config.database.connectionString) {
    pool = new pg_1.Pool({
        connectionString: config.database.connectionString,
        min: config.database.min,
        max: config.database.max,
        idleTimeoutMillis: config.database.idleTimeoutMillis,
        connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    });
}
else if (config.database.host) {
    pool = new pg_1.Pool({
        host: config.database.host,
        port: config.database.port,
        database: config.database.database,
        user: config.database.user,
        password: config.database.password,
        min: config.database.min,
        max: config.database.max,
        idleTimeoutMillis: config.database.idleTimeoutMillis,
        connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    });
}
// Create Kysely instance
exports.db = pool
    ? new kysely_1.Kysely({
        dialect: new kysely_1.PostgresDialect({ pool }),
        plugins: [new kysely_1.CamelCasePlugin()], // Convert snake_case to camelCase
    })
    : undefined;
/**
 * Transaction helper
 */
async function transaction(callback) {
    if (!exports.db) {
        throw new Error('Database not configured');
    }
    return await exports.db.transaction().execute(callback);
}
/**
 * Database health check
 */
async function checkHealth() {
    if (!exports.db || !pool) {
        return {
            connected: false,
            error: 'Database not configured'
        };
    }
    try {
        // Simple connectivity test
        await exports.db.selectFrom('users').select('id').limit(1).execute();
        // Get pool statistics
        const poolStats = {
            // @ts-ignore - accessing internal pool properties (Node-Postgres)
            total: pool.totalCount || 0,
            // @ts-ignore
            idle: pool.idleCount || 0,
            // @ts-ignore
            waiting: pool.waitingCount || 0,
        };
        return {
            connected: true,
            pool: poolStats,
        };
    }
    catch (error) {
        return {
            connected: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Graceful shutdown
 */
async function closeDatabase() {
    if (pool) {
        await pool.end();
    }
}
/**
 * Query builder helpers
 */
exports.qb = {
    /**
     * Build a dynamic where clause
     */
    dynamicWhere(query, conditions) {
        let result = query;
        for (const [key, value] of Object.entries(conditions)) {
            if (value !== undefined && value !== null) {
                result = result.where(key, '=', value);
            }
        }
        return result;
    },
    /**
     * Apply pagination
     */
    paginate(query, page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        return query.limit(limit).offset(offset);
    },
    /**
     * Apply sorting
     */
    orderBy(query, sortBy = 'created_at', order = 'desc') {
        return query.orderBy(sortBy, order);
    },
};
// Export everything needed
exports.default = exports.db;
//# sourceMappingURL=kysely.js.map