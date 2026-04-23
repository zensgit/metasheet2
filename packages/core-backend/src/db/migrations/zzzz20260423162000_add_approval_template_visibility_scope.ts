import type { Pool } from 'pg'

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE approval_templates
      ADD COLUMN IF NOT EXISTS visibility_scope JSONB NOT NULL DEFAULT '{"type":"all","ids":[]}'::jsonb
  `)
  await pool.query(`
    UPDATE approval_templates
    SET visibility_scope = '{"type":"all","ids":[]}'::jsonb
    WHERE visibility_scope IS NULL
  `)
  await pool.query(`
    ALTER TABLE approval_templates
      DROP CONSTRAINT IF EXISTS approval_templates_visibility_scope_shape
  `)
  await pool.query(`
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
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_templates_visibility_scope_type
      ON approval_templates ((visibility_scope->>'type'))
  `)
}

export async function down(pool: Pool): Promise<void> {
  await pool.query('DROP INDEX IF EXISTS idx_approval_templates_visibility_scope_type')
  await pool.query('ALTER TABLE approval_templates DROP CONSTRAINT IF EXISTS approval_templates_visibility_scope_shape')
  await pool.query('ALTER TABLE approval_templates DROP COLUMN IF EXISTS visibility_scope')
}
