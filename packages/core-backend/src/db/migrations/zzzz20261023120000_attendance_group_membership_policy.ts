import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_management_group_policies (
      org_id text PRIMARY KEY,
      allow_multiple_groups boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS attendance_management_group_policies`.execute(db)
}
