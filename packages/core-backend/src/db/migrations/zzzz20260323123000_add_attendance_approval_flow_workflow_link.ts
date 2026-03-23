import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('attendance_approval_flows')
    .addColumn('workflow_id', 'uuid', (col) => col.references('workflow_definitions.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('attendance_approval_flows')
    .dropColumn('workflow_id')
    .execute()
}
