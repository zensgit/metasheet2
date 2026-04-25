import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Wave 2 WP5 slice 1 — SLA / approval-duration observability.
 *
 * Adds a per-instance metrics row (approval_metrics) and a nullable
 * sla_hours column on approval_templates. Writes are additive and guarded
 * in ApprovalProductService so metrics errors never fail the parent flow.
 *
 * Deviations from the task spec (documented in the dev MD):
 *   - `instance_id` is TEXT (approval_instances.id is TEXT, not UUID).
 *   - `tenant_id` is TEXT with a 'default' fallback — approval_instances
 *     has no tenancy column, so the metrics row inherits the loose TEXT
 *     scoping used by the integration_* tables.
 *   - Terminal state mirrors the production status enum
 *     (approved/rejected/revoked/returned). 'returned' is recorded on the
 *     first return action; the row is re-opened when the instance loops
 *     back to pending, but duration_seconds stays set until a subsequent
 *     terminal transition overwrites it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    ALTER TABLE approval_templates
      ADD COLUMN IF NOT EXISTS sla_hours INTEGER
  `.execute(db)
  await sql`
    ALTER TABLE approval_templates
      DROP CONSTRAINT IF EXISTS approval_templates_sla_hours_positive
  `.execute(db)
  await sql`
    ALTER TABLE approval_templates
      ADD CONSTRAINT approval_templates_sla_hours_positive
      CHECK (sla_hours IS NULL OR sla_hours > 0)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS approval_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id TEXT NOT NULL UNIQUE REFERENCES approval_instances(id) ON DELETE CASCADE,
      template_id UUID,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      started_at TIMESTAMPTZ NOT NULL,
      terminal_at TIMESTAMPTZ,
      terminal_state TEXT,
      duration_seconds INTEGER,
      sla_hours INTEGER,
      sla_breached BOOLEAN NOT NULL DEFAULT FALSE,
      sla_breached_at TIMESTAMPTZ,
      node_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    ALTER TABLE approval_metrics
      DROP CONSTRAINT IF EXISTS approval_metrics_terminal_state_check
  `.execute(db)
  await sql`
    ALTER TABLE approval_metrics
      ADD CONSTRAINT approval_metrics_terminal_state_check
      CHECK (terminal_state IS NULL OR terminal_state IN ('approved', 'rejected', 'revoked', 'returned'))
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_tenant_terminal
      ON approval_metrics(tenant_id, terminal_at DESC)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_template
      ON approval_metrics(template_id)
      WHERE template_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_sla_breached_active
      ON approval_metrics(tenant_id, sla_breached)
      WHERE sla_breached = TRUE
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_sla_scan
      ON approval_metrics(started_at)
      WHERE terminal_at IS NULL AND sla_hours IS NOT NULL AND sla_breached = FALSE
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION approval_metrics_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_approval_metrics_updated_at') THEN
        CREATE TRIGGER trg_approval_metrics_updated_at
          BEFORE UPDATE ON approval_metrics
          FOR EACH ROW EXECUTE FUNCTION approval_metrics_set_updated_at();
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_approval_metrics_updated_at ON approval_metrics`.execute(db)
  await sql`DROP FUNCTION IF EXISTS approval_metrics_set_updated_at()`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_sla_scan`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_sla_breached_active`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_template`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_tenant_terminal`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_metrics`.execute(db)
  await sql`ALTER TABLE approval_templates DROP CONSTRAINT IF EXISTS approval_templates_sla_hours_positive`.execute(db)
  await sql`ALTER TABLE approval_templates DROP COLUMN IF EXISTS sla_hours`.execute(db)
}
