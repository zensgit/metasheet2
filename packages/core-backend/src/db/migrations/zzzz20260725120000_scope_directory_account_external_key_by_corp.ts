import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const LEGACY_INDEX = 'idx_directory_accounts_provider_external_key'
const CORP_SCOPED_INDEX = 'idx_directory_accounts_provider_corp_external_key'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create the stricter replacement before dropping the legacy index. Existing data that
  // satisfied global uniqueness necessarily satisfies corp-scoped uniqueness, so a failure
  // leaves the old protection in place.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id(CORP_SCOPED_INDEX)}
    ON directory_accounts(provider, corp_id, external_key) NULLS NOT DISTINCT
  `.execute(db)
  await sql`DROP INDEX IF EXISTS ${sql.id(LEGACY_INDEX)}`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Recreate the legacy protection first. Once two corps legitimately hold the same key,
  // rollback is data-incompatible and must fail without removing the scoped index.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id(LEGACY_INDEX)}
    ON directory_accounts(provider, external_key)
  `.execute(db)
  await sql`DROP INDEX IF EXISTS ${sql.id(CORP_SCOPED_INDEX)}`.execute(db)
}
