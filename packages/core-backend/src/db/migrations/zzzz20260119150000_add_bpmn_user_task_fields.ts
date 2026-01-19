import type { Kysely } from 'kysely'
import { addColumnIfNotExists, checkTableExists, dropColumnIfExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'bpmn_user_tasks')
  if (!exists) return

  await addColumnIfNotExists(db, 'bpmn_user_tasks', 'variables', 'jsonb', {
    notNull: true,
    defaultTo: "sql:'{}'::jsonb",
  })
  await addColumnIfNotExists(db, 'bpmn_user_tasks', 'form_data', 'jsonb')
  await addColumnIfNotExists(db, 'bpmn_user_tasks', 'claimed_at', 'timestamptz')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropColumnIfExists(db, 'bpmn_user_tasks', 'claimed_at')
  await dropColumnIfExists(db, 'bpmn_user_tasks', 'form_data')
  await dropColumnIfExists(db, 'bpmn_user_tasks', 'variables')
}
