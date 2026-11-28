import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Adding the default separately avoids rewriting existing records. NULL identifies an
  // existing record until it is physically removed. A new row, including a restore with
  // the same id and original created_at, receives a fresh incarnation.
  await sql`ALTER TABLE meta_records ADD COLUMN yjs_incarnation uuid`.execute(db)
  await sql`ALTER TABLE meta_records ALTER COLUMN yjs_incarnation SET DEFAULT gen_random_uuid()`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_records DROP COLUMN yjs_incarnation`.execute(db)
}
