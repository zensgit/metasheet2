import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

type SeedRole = {
  id: string
  name: string
  permissions: string[]
}

const attendanceRoles: SeedRole[] = [
  {
    id: 'attendance_employee',
    name: 'Attendance Employee',
    permissions: ['attendance:read', 'attendance:write'],
  },
  {
    id: 'attendance_approver',
    name: 'Attendance Approver',
    permissions: ['attendance:read', 'attendance:approve'],
  },
  {
    id: 'attendance_admin',
    name: 'Attendance Admin',
    permissions: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin'],
  },
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const rolesExists = await checkTableExists(db, 'roles')
  if (!rolesExists) {
    await db.schema
      .createTable('roles')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  // Backfill roles from existing references to avoid breaking routes that check role existence.
  const userRolesExists = await checkTableExists(db, 'user_roles')
  if (userRolesExists) {
    await sql`
      INSERT INTO roles (id, name)
      SELECT DISTINCT ur.role_id, ur.role_id
      FROM user_roles ur
      WHERE ur.role_id IS NOT NULL AND ur.role_id <> ''
      ON CONFLICT (id) DO NOTHING;
    `.execute(db)
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists) {
    await sql`
      INSERT INTO roles (id, name)
      SELECT DISTINCT rp.role_id, rp.role_id
      FROM role_permissions rp
      WHERE rp.role_id IS NOT NULL AND rp.role_id <> ''
      ON CONFLICT (id) DO NOTHING;
    `.execute(db)
  }

  // Seed attendance roles used by the Attendance Admin Center "User Access" panel.
  await sql`
    INSERT INTO roles (id, name)
    VALUES
      ('attendance_employee', 'Attendance Employee'),
      ('attendance_approver', 'Attendance Approver'),
      ('attendance_admin', 'Attendance Admin')
    ON CONFLICT (id) DO NOTHING;
  `.execute(db)

  // Ensure role_permissions has the expected mapping (permissions are seeded elsewhere).
  const permissionsExists = await checkTableExists(db, 'permissions')
  if (rolePermissionsExists && permissionsExists) {
    for (const role of attendanceRoles) {
      for (const permissionCode of role.permissions) {
        // DO $$ blocks do not support Kysely bind parameters reliably, so keep this as a plain query.
        await sql`
          INSERT INTO role_permissions (role_id, permission_code)
          SELECT ${role.id}, p.code
          FROM permissions p
          WHERE p.code = ${permissionCode}
          ON CONFLICT DO NOTHING;
        `.execute(db)
      }
    }
  }
}

// Intentionally no-op: dropping roles or removing role_permissions can break running environments.
export async function down(_db: Kysely<unknown>): Promise<void> {
  return
}
