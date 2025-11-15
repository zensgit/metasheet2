#!/usr/bin/env tsx
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pg_1 = require("./pg");
async function ensureMigrationsTable() {
    if (!pg_1.pool)
        throw new Error('DATABASE_URL not configured');
    await pg_1.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
async function appliedSet() {
    const res = await pg_1.pool.query('SELECT filename FROM schema_migrations');
    return new Set(res.rows.map((r) => r.filename));
}
async function main() {
    if (!pg_1.pool)
        throw new Error('DATABASE_URL not configured');
    const dir = path_1.default.join(__dirname, '..', '..', 'migrations');
    if (!fs_1.default.existsSync(dir)) {
        console.log('No migrations directory found, skipping');
        return;
    }
    await ensureMigrationsTable();
    const files = fs_1.default.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const done = await appliedSet();
    for (const file of files) {
        if (done.has(file)) {
            continue;
        }
        const full = path_1.default.join(dir, file);
        const sql = fs_1.default.readFileSync(full, 'utf-8');
        console.log(`Applying migration: ${file}`);
        const client = await pg_1.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`Applied: ${file}`);
        }
        catch (e) {
            await client.query('ROLLBACK');
            console.error(`Failed migration ${file}:`, e);
            process.exit(1);
        }
        finally {
            client.release();
        }
    }
    console.log('Migrations complete');
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map