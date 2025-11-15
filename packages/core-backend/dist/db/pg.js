"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.withTransaction = withTransaction;
exports.getPoolStats = getPoolStats;
const pg_1 = require("pg");
const connectionString = process.env.DATABASE_URL || '';
const max = parseInt(process.env.PGPOOL_MAX || '10', 10);
const idleTimeoutMillis = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10);
const connectionTimeoutMillis = parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10);
exports.pool = connectionString
    ? new pg_1.Pool({ connectionString, max, idleTimeoutMillis, connectionTimeoutMillis })
    : undefined;
async function query(text, params) {
    if (!exports.pool)
        throw new Error('DATABASE_URL not configured');
    return exports.pool.query(text, params);
}
async function withTransaction(fn) {
    if (!exports.pool)
        throw new Error('DATABASE_URL not configured');
    const client = await exports.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}
function getPoolStats() {
    if (!exports.pool)
        return null;
    // @ts-ignore - pg types don't expose these counts in d.ts
    return { total: exports.pool.totalCount || 0, idle: exports.pool.idleCount || 0, waiting: exports.pool.waitingCount || 0 };
}
//# sourceMappingURL=pg.js.map