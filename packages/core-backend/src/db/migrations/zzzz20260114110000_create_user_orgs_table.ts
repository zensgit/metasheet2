import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'
import { checkTableExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)

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
