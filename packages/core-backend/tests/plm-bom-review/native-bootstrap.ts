import type { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { up as core } from "../../src/db/migrations/zzzz20260404153000_repair_meta_core_schema";
import { up as locks } from "../../src/db/migrations/zzzz20260612140000_add_meta_record_locked";
import { up as conditionalRead } from "../../src/db/migrations/zzzz20260618120000_conditional_read_rules";
import { up as comments } from "../../src/db/migrations/zzzz20260318123000_formalize_meta_comments";
import { up as commentReads } from "../../src/db/migrations/zzzz20260404121000_create_meta_comment_reads";
import { up as commentReactions } from "../../src/db/migrations/zzzz20260615190000_create_meta_comment_reactions";

// Extend the disposable predecessor catalog for the real native routers. The original BOM/auth
// fixture has already run. This is not a complete fresh-install migration-chain rehearsal.
export async function bootstrapBomReviewNativeHttpDb(
  pool: Pool,
): Promise<void> {
  await pool.query(`
    ALTER TABLE meta_bases ADD COLUMN IF NOT EXISTS icon text,
      ADD COLUMN IF NOT EXISTS color text, ADD COLUMN IF NOT EXISTS workspace_id text;
    ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    ALTER TABLE meta_fields ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    ALTER TABLE spreadsheet_permissions ADD COLUMN IF NOT EXISTS user_id text;
    CREATE TABLE IF NOT EXISTS platform_member_groups(id uuid PRIMARY KEY,name text NOT NULL,description text);
  `);
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  for (const up of [
    core,
    locks,
    conditionalRead,
    comments,
    commentReads,
    commentReactions,
  ]) {
    await up(db);
  }
}
