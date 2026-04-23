import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE approval_templates
      ADD COLUMN IF NOT EXISTS visibility_scope JSONB NOT NULL DEFAULT '{"type":"all","ids":[]}'::jsonb
  `.execute(db)
  await sql`
    UPDATE approval_templates
    SET visibility_scope = '{"type":"all","ids":[]}'::jsonb
    WHERE visibility_scope IS NULL
  `.execute(db)
  await sql`
    ALTER TABLE approval_templates
      DROP CONSTRAINT IF EXISTS approval_templates_visibility_scope_shape
  `.execute(db)
  await sql`
    ALTER TABLE approval_templates
      ADD CONSTRAINT approval_templates_visibility_scope_shape
      CHECK (
        jsonb_typeof(visibility_scope) = 'object'
        AND visibility_scope ? 'type'
        AND visibility_scope->>'type' IN ('all', 'dept', 'role', 'user')
        AND (
          NOT (visibility_scope ? 'ids')
          OR jsonb_typeof(visibility_scope->'ids') = 'array'
        )
      )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_templates_visibility_scope_type
      ON approval_templates ((visibility_scope->>'type'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_templates_visibility_scope_type`.execute(db)
  await sql`ALTER TABLE approval_templates DROP CONSTRAINT IF EXISTS approval_templates_visibility_scope_shape`.execute(db)
  await sql`ALTER TABLE approval_templates DROP COLUMN IF EXISTS visibility_scope`.execute(db)
}
