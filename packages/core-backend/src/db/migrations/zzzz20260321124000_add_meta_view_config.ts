import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('meta_views')
    .addColumn('config', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .execute()

  await db
    .updateTable('meta_views')
    .set({ config: sql`'{}'::jsonb` })
    .where('config', 'is', null)
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('meta_views')
    .dropColumn('config')
    .execute()
}
