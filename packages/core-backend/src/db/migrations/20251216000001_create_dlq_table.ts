import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('dead_letter_queue')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('topic', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('error_message', 'text')
    .addColumn('retry_count', 'integer', (col) => col.defaultTo(0))
    .addColumn('last_retry_at', 'timestamptz')
    .addColumn('status', 'text', (col) => col.defaultTo('pending')) // pending, retrying, resolved, ignored
    .addColumn('metadata', 'jsonb', (col) => col.defaultTo(sql`'{}'`))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_dlq_status ON dead_letter_queue(status)`.execute(db)
  await sql`CREATE INDEX idx_dlq_topic ON dead_letter_queue(topic)`.execute(db)
  await sql`CREATE INDEX idx_dlq_created_at ON dead_letter_queue(created_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dead_letter_queue').execute()
}
