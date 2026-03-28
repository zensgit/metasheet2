import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'plm_workbench_team_views')
  if (!tableExists) return

  const hasArchivedAt = await checkColumnExists(db, 'plm_workbench_team_views', 'archived_at')
  if (!hasArchivedAt) {
    await db.schema
      .alterTable('plm_workbench_team_views')
      .addColumn('archived_at', 'timestamptz')
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'plm_workbench_team_views')
  if (!tableExists) return

  const hasArchivedAt = await checkColumnExists(db, 'plm_workbench_team_views', 'archived_at')
  if (hasArchivedAt) {
    await db.schema
      .alterTable('plm_workbench_team_views')
      .dropColumn('archived_at')
      .execute()
  }
}
