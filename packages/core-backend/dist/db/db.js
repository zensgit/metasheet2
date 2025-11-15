"use strict";
/**
 * Database adapter for EventBusService
 * Provides Kysely instance for type-safe database queries
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.db = void 0;
const kysely_1 = require("kysely");
const pg_1 = require("pg");
// Create pg pool
const connectionString = process.env.DATABASE_URL || '';
const pool = connectionString
    ? new pg_1.Pool({ connectionString })
    : undefined;
exports.pool = pool;
// Create Kysely instance with PostgreSQL dialect
exports.db = pool ? new kysely_1.Kysely({
    dialect: new kysely_1.PostgresDialect({
        pool: pool
    })
}) : undefined;
//# sourceMappingURL=db.js.map