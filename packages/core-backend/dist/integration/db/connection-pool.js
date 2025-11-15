"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.poolManager = void 0;
const pg_1 = require("pg");
class ConnectionPool {
    pool;
    slowMs;
    name;
    constructor(opts) {
        this.pool = new pg_1.Pool(opts);
        this.slowMs = opts.slowQueryMs || parseInt(process.env.DB_SLOW_MS || '500', 10);
        this.name = opts.name || 'main';
    }
    async healthCheck() {
        await this.pool.query('SELECT 1');
    }
    async query(sql, params, _options) {
        const start = Date.now();
        const res = await this.pool.query(sql, params);
        const ms = Date.now() - start;
        if (ms > this.slowMs) {
            // eslint-disable-next-line no-console
            console.warn('[db][slow]', { name: this.name, ms, sql: sql.slice(0, 160) });
        }
        return res;
    }
    async transaction(handler) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await handler({ query: client.query.bind(client) });
            await client.query('COMMIT');
            return result;
        }
        catch (e) {
            try {
                await client.query('ROLLBACK');
            }
            catch { }
            throw e;
        }
        finally {
            client.release();
        }
    }
}
class PoolManager {
    main;
    pools = new Map();
    constructor() {
        this.main = this.createPool('main', {
            connectionString: process.env.DATABASE_URL,
            max: parseInt(process.env.DB_POOL_MAX || '20', 10),
            idleTimeoutMillis: 30000,
            slowQueryMs: parseInt(process.env.DB_SLOW_MS || '500', 10),
            name: 'main'
        });
    }
    createPool(name, opts) {
        const pool = new ConnectionPool({ ...opts, name });
        this.pools.set(name, pool);
        if (name === 'main')
            this.main = pool;
        return pool;
    }
    get(name = 'main') {
        return this.pools.get(name) || this.main;
    }
    async healthCheck() {
        await Promise.all(Array.from(this.pools.values()).map(p => p.healthCheck()));
    }
}
exports.poolManager = new PoolManager();
//# sourceMappingURL=connection-pool.js.map