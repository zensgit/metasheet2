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
    const perms: Array<{ code: string; name: string; description: string | null }> = [
      { code: 'demo:read', name: 'Demo Read', description: 'Demo read permission for CI' },
      { code: 'permissions:read', name: 'Permissions Read', description: 'List permissions' },
      { code: 'permissions:write', name: 'Permissions Write', description: 'Grant/Revoke permissions' },
      { code: 'roles:read', name: 'Roles Read', description: 'List roles' },
      { code: 'roles:write', name: 'Roles Write', description: 'Manage roles' },
      { code: 'attendance:read', name: 'Attendance Read', description: 'Read attendance data' },
      { code: 'attendance:write', name: 'Attendance Write', description: 'Create attendance punches and requests' },
      { code: 'attendance:approve', name: 'Attendance Approve', description: 'Approve attendance adjustment requests' },
      { code: 'attendance:admin', name: 'Attendance Admin', description: 'Manage attendance rules' },
    ]
    for (const { code, name, description } of perms) {
      await client.query(
        'INSERT INTO permissions(code, name, description) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING',
        [code, name, description]
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
