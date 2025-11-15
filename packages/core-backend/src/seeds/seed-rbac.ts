#!/usr/bin/env tsx
import { pool } from '../db/pg'

async function main() {
  if (!pool) throw new Error('DATABASE_URL not configured')

  // Ensure admin role
  await pool.query(`INSERT INTO roles(id, name) VALUES ('admin','Administrator') ON CONFLICT (id) DO NOTHING`)

  // Seed common permissions (optional for non-admin users)
  const perms = [
    'roles:read','roles:write',
    'permissions:read','permissions:write',
    'spreadsheets:read','spreadsheets:write',
    'files:read','files:write',
    'spreadsheet-permissions:read','spreadsheet-permissions:write',
    'audit:read'
  ]
  for (const code of perms) {
    await pool.query(`INSERT INTO permissions(code) VALUES ($1) ON CONFLICT (code) DO NOTHING`, [code])
  }

  // Optionally grant all perms to admin role (not required for isAdmin bypass, but useful for explicit checks)
  for (const code of perms) {
    await pool.query(`INSERT INTO role_permissions(role_id, permission_code) VALUES ('admin',$1) ON CONFLICT DO NOTHING`, [code])
  }

  // Bind admin role to default user u1 (used by dev token script)
  const userId = process.env.SEED_USER_ID || 'u1'
  await pool.query(`INSERT INTO user_roles(user_id, role_id) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [userId])

  console.log(`Seeded RBAC: role=admin, user=${userId}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

