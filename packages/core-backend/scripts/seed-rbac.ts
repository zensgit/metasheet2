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
    const adminUserId = process.env.SEED_USER_ID || process.env.RBAC_ADMIN_USER || 'dev-user'
    const adminRoleId = process.env.RBAC_ADMIN_ROLE || process.env.SEED_USER_ROLE || 'admin'
    const adminEmail = process.env.SEED_USER_EMAIL || `${adminUserId}@test.local`
    const adminRole = adminRoleId || 'admin'
    const isAdmin = adminRole === 'admin'
    const perms: Array<[string, string, string | null]> = [
      ['demo:read', 'Demo Read', 'Demo read permission for CI'],
      ['permissions:read', 'Permissions Read', 'List permissions'],
      ['permissions:write', 'Permissions Write', 'Grant/Revoke permissions'],
      ['roles:read', 'Roles Read', 'List roles'],
      ['roles:write', 'Roles Write', 'Manage roles'],
      ['attendance:read', 'Attendance Read', 'Read attendance data'],
      ['attendance:write', 'Attendance Write', 'Create attendance punches and requests'],
      ['attendance:approve', 'Attendance Approve', 'Approve attendance adjustment requests'],
      ['attendance:admin', 'Attendance Admin', 'Manage attendance rules'],
    ]
    for (const [code, name, desc] of perms) {
      await client.query(
        'INSERT INTO permissions(code, name, description) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING',
        [code, name, desc]
      )
    }
    await client.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_admin)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6)
       ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           role = EXCLUDED.role,
           is_admin = EXCLUDED.is_admin`,
      [adminUserId, adminEmail, adminUserId, 'seeded', adminRole, isAdmin]
    )
    await client.query(
      'INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT (user_id, role_id) DO NOTHING',
      [adminUserId, adminRoleId]
    )
    await client.query('COMMIT')
    console.log(`RBAC seed complete (admin ${adminUserId} -> ${adminRoleId})`)
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
