import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * Q4 (T2-3 review) — gate person-level approval analytics behind a SEPARATE permission.
 *
 * `/api/approvals/metrics/people` aggregates per-requester approval throughput into a
 * who-is-slowest performance ranking. That is an HR/operations-analytics lens, materially
 * distinct from approval template/process administration, so it must NOT default to
 * `approvals:admin`. This registers a dedicated `approvals:analytics` permission and grants
 * it to the global `admin` role (full admins keep access; a user holding only the granular
 * `approvals:admin` permission does not). Team/department aggregation (`/teams`) stays on
 * `approvals:admin` (lower sensitivity).
 */
const APPROVALS_ANALYTICS_PERMISSION = 'approvals:analytics'

export async function up(db: Kysely<unknown>): Promise<void> {
  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      INSERT INTO permissions (code, name, description)
      VALUES (${APPROVALS_ANALYTICS_PERMISSION}, 'Approvals Analytics', 'View person-level approval process analytics (performance aggregations)')
      ON CONFLICT (code) DO NOTHING
    `.execute(db)
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (permissionsExists && rolePermissionsExists) {
    await sql`
      INSERT INTO role_permissions (role_id, permission_code)
      SELECT 'admin', p.code
      FROM permissions p
      WHERE p.code = ${APPROVALS_ANALYTICS_PERMISSION}
      ON CONFLICT DO NOTHING
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  if (rolePermissionsExists) {
    await sql`
      DELETE FROM role_permissions
      WHERE permission_code = ${APPROVALS_ANALYTICS_PERMISSION}
    `.execute(db)
  }

  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      DELETE FROM permissions
      WHERE code = ${APPROVALS_ANALYTICS_PERMISSION}
    `.execute(db)
  }
}
