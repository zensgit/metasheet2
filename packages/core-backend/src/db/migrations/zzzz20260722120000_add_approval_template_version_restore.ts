import { sql } from 'kysely'
import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE approval_template_versions
    ADD COLUMN IF NOT EXISTS restored_from_version_id UUID
      REFERENCES approval_template_versions(id) ON DELETE SET NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_template_versions_restored_from
    ON approval_template_versions(restored_from_version_id)
    WHERE restored_from_version_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_template_versions_restored_from`.execute(db)
  await sql`
    ALTER TABLE approval_template_versions
    DROP COLUMN IF EXISTS restored_from_version_id
  `.execute(db)
}
