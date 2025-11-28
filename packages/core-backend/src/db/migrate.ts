#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import { pool } from './pg'

async function ensureMigrationsTable() {
  if (!pool) throw new Error('DATABASE_URL not configured')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

async function appliedSet(): Promise<Set<string>> {
  const res = await pool!.query<{ filename: string }>('SELECT filename FROM schema_migrations')
  return new Set(res.rows.map((r: any) => r.filename))
}

async function main() {
  if (!pool) throw new Error('DATABASE_URL not configured')
  const dir = path.join(__dirname, '..', '..', 'migrations')
  if (!fs.existsSync(dir)) {
    console.log('No migrations directory found, skipping')
    return
  }

  await ensureMigrationsTable()
  // Support excluding specific migration files via env (comma-separated)
  const exclude = (process.env.MIGRATION_EXCLUDE || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .filter(f => !exclude.includes(f))
    .sort()

  if (exclude.length > 0) {
    console.log(`↷ MIGRATION_EXCLUDE active; skipping: ${exclude.join(', ')}`)
  }
  const done = await appliedSet()

  for (const file of files) {
    if (done.has(file)) {
      continue
    }
    const full = path.join(dir, file)
    const sql = fs.readFileSync(full, 'utf-8')
    console.log(`Applying migration: ${file}`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`Applied: ${file}`)
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`Failed migration ${file}:`, e)
      process.exit(1)
    } finally {
      client.release()
    }
  }
  console.log('Migrations complete')
}

// Only run when executed directly, not when imported in tests
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
