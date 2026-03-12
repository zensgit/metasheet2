import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'plm_filter_team_presets')
  if (!tableExists) return

  const hasIsDefault = await checkColumnExists(db, 'plm_filter_team_presets', 'is_default')
  if (!hasIsDefault) {
    await db.schema
      .alterTable('plm_filter_team_presets')
      .addColumn('is_default', 'boolean', (col) => col.notNull().defaultTo(false))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plm_filter_team_presets_default
    ON plm_filter_team_presets(tenant_id, scope, kind)
    WHERE is_default = true
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_plm_filter_team_presets_default`.execute(db)

  const tableExists = await checkTableExists(db, 'plm_filter_team_presets')
  if (!tableExists) return

  const hasIsDefault = await checkColumnExists(db, 'plm_filter_team_presets', 'is_default')
  if (hasIsDefault) {
    await db.schema
      .alterTable('plm_filter_team_presets')
      .dropColumn('is_default')
      .execute()
  }
}
