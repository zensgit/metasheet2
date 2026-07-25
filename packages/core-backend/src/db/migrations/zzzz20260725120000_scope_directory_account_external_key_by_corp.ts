import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const LEGACY_INDEX = 'idx_directory_accounts_provider_external_key'
const CORP_SCOPED_INDEX = 'idx_directory_accounts_provider_corp_external_key'
const NULL_CORP_SCOPED_INDEX = 'idx_directory_accounts_provider_null_corp_external_key'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create both replacement guards before dropping the legacy index. Two partial indexes
  // preserve NULL-as-one-scope semantics without requiring PostgreSQL 15's NULLS NOT DISTINCT.
  // Existing data satisfying global uniqueness necessarily satisfies both replacements, and a
  // partial failure leaves the old protection in place.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id(CORP_SCOPED_INDEX)}
    ON directory_accounts(provider, corp_id, external_key)
    WHERE corp_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id(NULL_CORP_SCOPED_INDEX)}
    ON directory_accounts(provider, external_key)
    WHERE corp_id IS NULL
  `.execute(db)
  await sql`DROP INDEX IF EXISTS ${sql.id(LEGACY_INDEX)}`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Recreate the legacy protection first. Once two corps legitimately hold the same key,
  // rollback is data-incompatible and must fail without removing either scoped index.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id(LEGACY_INDEX)}
    ON directory_accounts(provider, external_key)
  `.execute(db)
  await sql`DROP INDEX IF EXISTS ${sql.id(CORP_SCOPED_INDEX)}`.execute(db)
  await sql`DROP INDEX IF EXISTS ${sql.id(NULL_CORP_SCOPED_INDEX)}`.execute(db)
}
