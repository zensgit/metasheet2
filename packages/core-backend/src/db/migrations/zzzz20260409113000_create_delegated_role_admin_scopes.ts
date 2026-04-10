import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const scopesExists = await checkTableExists(db, 'delegated_role_admin_scopes')
  if (!scopesExists) {
    await db.schema
      .createTable('delegated_role_admin_scopes')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('admin_user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('namespace', 'text', (col) => col.notNull())
      .addColumn('directory_department_id', 'uuid', (col) => col.notNull().references('directory_departments.id').onDelete('cascade'))
      .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_role_admin_scopes_unique
    ON delegated_role_admin_scopes(admin_user_id, namespace, directory_department_id)
  `.execute(db)
  await createIndexIfNotExists(
    db,
    'idx_delegated_role_admin_scopes_admin_user',
    'delegated_role_admin_scopes',
    'admin_user_id',
  )
  await createIndexIfNotExists(
    db,
    'idx_delegated_role_admin_scopes_department',
    'delegated_role_admin_scopes',
    'directory_department_id',
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('delegated_role_admin_scopes').ifExists().cascade().execute()
}
