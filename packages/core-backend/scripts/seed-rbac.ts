#!/usr/bin/env tsx
/**
 * Minimal RBAC seed script.
 * Ensures base permissions exist to satisfy CI RBAC happy-path and avoid FK errors.
 */
import pg from 'pg'

const { Pool } = pg as any

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(2)
  }
  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const perms: Array<[string, string | null]> = [
      ['demo:read', 'Demo read permission for CI'],
      ['permissions:read', 'List permissions'],
      ['permissions:write', 'Grant/Revoke permissions'],
      ['roles:read', 'List roles'],
      ['roles:write', 'Manage roles'],
    ]
    for (const [code, desc] of perms) {
      await client.query(
        'INSERT INTO permissions(code, description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',
        [code, desc]
      )
    }
    await client.query('COMMIT')
    console.log('RBAC seed complete')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('RBAC seed failed', e)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main()

