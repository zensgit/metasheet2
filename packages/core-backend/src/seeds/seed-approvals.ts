#!/usr/bin/env tsx
import { pool } from '../db/pg'

async function main() {
  if (!pool) throw new Error('DATABASE_URL not configured')
  await pool.query(`INSERT INTO approval_instances(id, status, version)
                    VALUES ('demo-1','PENDING',0)
                    ON CONFLICT (id) DO NOTHING`)
  console.log('Seeded approval_instances demo-1')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

