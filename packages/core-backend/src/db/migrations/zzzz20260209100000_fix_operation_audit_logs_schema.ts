import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * operation_audit_logs schema hardening
 *
 * The codebase historically wrote to `created_at` + `metadata`, while the query
 * router (`/api/audit-logs`) expects `occurred_at` + `meta`. This migration
 * aligns the schema and backfills existing rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'operation_audit_logs')
  if (!exists) return

  await sql`ALTER TABLE operation_audit_logs
    ADD COLUMN IF NOT EXISTS occurred_at timestamptz
  `.execute(db)

  // Backfill occurred_at for existing rows written before this column existed.
  await sql`UPDATE operation_audit_logs
    SET occurred_at = created_at
    WHERE occurred_at IS NULL
  `.execute(db)

  // Keep occurred_at non-null for future writes.
  await sql`ALTER TABLE operation_audit_logs
    ALTER COLUMN occurred_at SET DEFAULT now()
  `.execute(db)
  await sql`ALTER TABLE operation_audit_logs
    ALTER COLUMN occurred_at SET NOT NULL
  `.execute(db)

  // Ensure meta has a default, and backfill from legacy metadata where missing.
  await sql`ALTER TABLE operation_audit_logs
    ADD COLUMN IF NOT EXISTS meta jsonb
  `.execute(db)
  await sql`ALTER TABLE operation_audit_logs
    ALTER COLUMN meta SET DEFAULT '{}'::jsonb
  `.execute(db)
  await sql`UPDATE operation_audit_logs
    SET meta = metadata
    WHERE (meta IS NULL OR meta = '{}'::jsonb)
      AND metadata IS NOT NULL
  `.execute(db)

  // Normalize IP column for older writers.
  await sql`UPDATE operation_audit_logs
    SET ip = ip_address
    WHERE ip IS NULL AND ip_address IS NOT NULL
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_occurred_at
    ON operation_audit_logs(occurred_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'operation_audit_logs')
  if (!exists) return

  await sql`DROP INDEX IF EXISTS idx_operation_audit_logs_occurred_at`.execute(db)
  await sql`ALTER TABLE operation_audit_logs DROP COLUMN IF EXISTS occurred_at`.execute(db)
}

