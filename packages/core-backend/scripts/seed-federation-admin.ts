#!/usr/bin/env tsx
import pg from 'pg'

const { Pool } = pg as any

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(2)
  }

  const userId = process.env.FEDERATION_ADMIN_USER_ID || 'dev-federation-admin'
  const roleId = process.env.FEDERATION_ADMIN_ROLE || 'admin'

  const permissions: Array<[string, string]> = [
    ['federation:read', 'Federation read'],
    ['federation:write', 'Federation write']
  ]

  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const [code, name] of permissions) {
      await client.query(
        'INSERT INTO permissions(code, name, description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING',
        [code, name, name]
      )
      await client.query(
        'INSERT INTO role_permissions(role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleId, code]
      )
      await client.query(
        'INSERT INTO user_permissions(user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, code]
      )
    }

    await client.query(
      'INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, roleId]
    )

    await client.query('COMMIT')
    console.log(`Seeded federation admin RBAC for user_id=${userId}`)
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    console.error('RBAC seed failed', error)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main()
