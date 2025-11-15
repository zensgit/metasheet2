#!/usr/bin/env tsx
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("../db/pg");
async function main() {
    if (!pg_1.pool)
        throw new Error('DATABASE_URL not configured');
    await pg_1.pool.query(`INSERT INTO approval_instances(id, status, version)
                    VALUES ('demo-1','PENDING',0)
                    ON CONFLICT (id) DO NOTHING`);
    console.log('Seeded approval_instances demo-1');
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=seed-approvals.js.map