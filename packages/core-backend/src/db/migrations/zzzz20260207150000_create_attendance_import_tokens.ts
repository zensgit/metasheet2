import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

/**
 * Production hardening:
 * Attendance import commit tokens must be shareable across multiple backend instances.
 * The plugin previously created this table at runtime; we migrate it so prod does not need DDL privileges.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'attendance_import_tokens')
  if (!tableExists) {
    await db.schema
      .createTable('attendance_import_tokens')
      .ifNotExists()
      .addColumn('token', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'attendance_import_tokens_org_idx', 'attendance_import_tokens', 'org_id')
  await createIndexIfNotExists(db, 'attendance_import_tokens_expires_idx', 'attendance_import_tokens', 'expires_at')
  await createIndexIfNotExists(db, 'attendance_import_tokens_user_idx', 'attendance_import_tokens', ['org_id', 'user_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_import_tokens').ifExists().cascade().execute()
}

