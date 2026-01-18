import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'user_orgs')
  if (!exists) {
    await db.schema
      .createTable('user_orgs')
      .ifNotExists()
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('org_id', 'text', col => col.notNull())
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`).notNull())
      .execute()
  }

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_orgs_pkey' AND conrelid = 'user_orgs'::regclass
      ) THEN
        ALTER TABLE user_orgs ADD PRIMARY KEY (user_id, org_id);
      END IF;
    END $$;
  `.execute(db)

  await createIndexIfNotExists(db, 'idx_user_orgs_org', 'user_orgs', 'org_id')

  const usersExists = await checkTableExists(db, 'users')
  if (usersExists) {
    await sql`
      INSERT INTO user_orgs (user_id, org_id, is_active)
      SELECT id, ${DEFAULT_ORG_ID}, true
      FROM users
      WHERE is_active = true
      ON CONFLICT (user_id, org_id) DO NOTHING
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_orgs').ifExists().cascade().execute()
}
