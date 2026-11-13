/** Existing source-management gates need grantable catalog entries.
 * Registration grants nothing and does not bypass namespace admission, source
 * ownership or the independent platform-admin approval for Visual Review.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'permissions'))) return
  for (const permission of [
    ['data_sources:read', 'Data Sources Read', 'Read sources allowed by source ownership and namespace admission'],
    ['data_sources:write', 'Data Sources Write', 'Manage allowed sources; Visual approval still requires a platform administrator'],
  ]) {
    await sql`
      INSERT INTO permissions (code, name, description)
      VALUES (${permission[0]}, ${permission[1]}, ${permission[2]})
      ON CONFLICT (code) DO NOTHING
    `.execute(db)
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // These identifiers guard existing routes. Retain the catalog and all grants
  // on rollback, including rows provisioned before this migration. No CASCADE.
}
