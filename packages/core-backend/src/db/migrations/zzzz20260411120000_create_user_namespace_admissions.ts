import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const PLATFORM_ADMIN_ROLE_ID = 'admin'
const NON_NAMESPACED_PERMISSION_RESOURCES = [
  'admin',
  'approvals',
  'audit',
  'auth',
  'cache',
  'comments',
  'demo',
  'events',
  'files',
  'health',
  'meta',
  'metrics',
  'multitable',
  'notification',
  'notifications',
  'permission',
  'permissions',
  'role',
  'roles',
  'session',
  'sessions',
  'snapshot',
  'snapshots',
  'spreadsheet',
  'spreadsheets',
  'workflow',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'user_namespace_admissions')
  if (!exists) {
    await db.schema
      .createTable('user_namespace_admissions')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('namespace', 'text', (col) => col.notNull())
      .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('source', 'text', (col) => col.notNull().defaultTo('platform_admin'))
      .addColumn('granted_by', 'text')
      .addColumn('updated_by', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_user_namespace_admissions_user_id', 'user_namespace_admissions', 'user_id')
  await createIndexIfNotExists(db, 'idx_user_namespace_admissions_namespace', 'user_namespace_admissions', 'namespace')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_namespace_admissions_user_namespace
    ON user_namespace_admissions(user_id, namespace)
  `.execute(db)

  await sql`
    WITH controlled_role_namespaces AS (
      SELECT DISTINCT
        ur.user_id,
        split_part(rp.permission_code, ':', 1) AS namespace
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE position(':' IN rp.permission_code) > 0
        AND split_part(rp.permission_code, ':', 1) <> ${PLATFORM_ADMIN_ROLE_ID}
        AND split_part(rp.permission_code, ':', 1) NOT IN (${sql.join(NON_NAMESPACED_PERMISSION_RESOURCES.map((value) => sql`${value}`), sql`, `)})
      UNION
      SELECT DISTINCT
        ur.user_id,
        left(ur.role_id, length(ur.role_id) - length('_admin')) AS namespace
      FROM user_roles ur
      WHERE ur.role_id LIKE '%\_admin' ESCAPE '\'
        AND ur.role_id <> ${PLATFORM_ADMIN_ROLE_ID}
        AND left(ur.role_id, length(ur.role_id) - length('_admin')) NOT IN (${sql.join(NON_NAMESPACED_PERMISSION_RESOURCES.map((value) => sql`${value}`), sql`, `)})
    )
    INSERT INTO user_namespace_admissions
      (user_id, namespace, enabled, source, created_at, updated_at)
    SELECT
      user_id,
      namespace,
      TRUE,
      'seed_backfill',
      NOW(),
      NOW()
    FROM controlled_role_namespaces
    WHERE namespace <> ''
    ON CONFLICT (user_id, namespace) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_namespace_admissions').ifExists().cascade().execute()
}
