import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'plm_filter_team_presets')
  if (!tableExists) return

  const hasArchivedAt = await checkColumnExists(db, 'plm_filter_team_presets', 'archived_at')
  if (!hasArchivedAt) {
    await db.schema
      .alterTable('plm_filter_team_presets')
      .addColumn('archived_at', 'timestamptz')
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'plm_filter_team_presets')
  if (!tableExists) return

  const hasArchivedAt = await checkColumnExists(db, 'plm_filter_team_presets', 'archived_at')
  if (hasArchivedAt) {
    await db.schema
      .alterTable('plm_filter_team_presets')
      .dropColumn('archived_at')
      .execute()
  }
}
