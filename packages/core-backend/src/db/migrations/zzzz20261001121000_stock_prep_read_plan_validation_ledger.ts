import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// The unified migration provider includes numeric SQL 087 before this file.
// The source revision migration sorts immediately before this one. No existing
// approved version or activation receives a synthetic successful receipt.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE integration_stock_prep_read_plan_validations (
      id TEXT PRIMARY KEY CHECK (id <> ''),
      contract_version TEXT NOT NULL CHECK (contract_version = 'plm-read-plan-validation.v1'),
      tenant_id TEXT NOT NULL CHECK (tenant_id <> ''),
      workspace_id TEXT CHECK (workspace_id IS NULL),
      version_id TEXT NOT NULL REFERENCES integration_stock_prep_read_plan_versions(id),
      action_id TEXT NOT NULL CHECK (action_id = 'plm.stock-preparation.pull-bom.v1'),
      system_id TEXT NOT NULL CHECK (system_id <> ''),
      content_key TEXT NOT NULL CHECK (content_key ~ '^[0-9a-f]{64}$'),
      actor TEXT NOT NULL CHECK (actor <> ''),
      connection_id TEXT NOT NULL CHECK (connection_id <> ''),
      connection_revision UUID NOT NULL,
      binding_revision UUID NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'confirmed', 'failed')),
      counts JSONB,
      begun_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      CONSTRAINT stock_prep_validation_expiry CHECK (expires_at = begun_at + INTERVAL '15 minutes'),
      CONSTRAINT stock_prep_validation_counts CHECK (
        counts IS NULL OR (
          jsonb_typeof(counts) = 'object'
          AND counts ?& ARRAY['sampleCount', 'readCount', 'objectCount']
          AND counts - ARRAY['sampleCount', 'readCount', 'objectCount'] = '{}'::jsonb
          AND jsonb_typeof(counts->'sampleCount') = 'number'
          AND jsonb_typeof(counts->'readCount') = 'number'
          AND jsonb_typeof(counts->'objectCount') = 'number'
          AND (counts->>'sampleCount') ~ '^[1-9][0-9]*$'
          AND (counts->>'readCount') ~ '^[1-9][0-9]*$'
          AND (counts->>'objectCount') ~ '^[1-9][0-9]*$'
          AND (counts->>'sampleCount')::bigint BETWEEN 1 AND 100000
          AND (counts->>'readCount')::bigint BETWEEN 1 AND 1000
          AND (counts->>'objectCount')::bigint BETWEEN 1 AND 7
        )
      ),
      CONSTRAINT stock_prep_validation_state CHECK (
        (status = 'pending' AND counts IS NULL AND finished_at IS NULL AND confirmed_at IS NULL)
        OR (status = 'failed' AND counts IS NULL AND finished_at IS NOT NULL AND confirmed_at IS NULL)
        OR (status = 'passed' AND counts IS NOT NULL AND finished_at IS NOT NULL AND confirmed_at IS NULL)
        OR (status = 'confirmed' AND counts IS NOT NULL AND finished_at IS NOT NULL AND confirmed_at IS NOT NULL)
      ),
      CONSTRAINT stock_prep_validation_finished_time CHECK (
        finished_at IS NULL OR (finished_at >= begun_at AND finished_at < expires_at)
      ),
      CONSTRAINT stock_prep_validation_confirmed_time CHECK (
        confirmed_at IS NULL OR (confirmed_at >= finished_at AND confirmed_at < expires_at)
      )
    );
    CREATE INDEX idx_stock_prep_validation_version
      ON integration_stock_prep_read_plan_validations (tenant_id, version_id, begun_at);
    CREATE INDEX idx_stock_prep_validation_pending_connection
      ON integration_stock_prep_read_plan_validations (connection_id, connection_revision, expires_at)
      WHERE status = 'pending';
    ALTER TABLE integration_stock_prep_read_plan_versions
      ADD COLUMN validation_id TEXT REFERENCES integration_stock_prep_read_plan_validations(id);
    ALTER TABLE integration_stock_prep_read_plan_activation
      ADD COLUMN validation_id TEXT REFERENCES integration_stock_prep_read_plan_validations(id);
    ALTER TABLE integration_stock_prep_read_plan_audit
      DROP CONSTRAINT integration_stock_prep_read_plan_audit_action_check;
    ALTER TABLE integration_stock_prep_read_plan_audit
      ADD CONSTRAINT integration_stock_prep_read_plan_audit_action_check CHECK (
        action IN ('save_version', 'reuse_version', 'status_change', 'activate', 'deactivate',
          'validation_begin', 'validation_finish', 'validation_confirm', 'validation_fail')
      ),
      ADD CONSTRAINT stock_prep_validation_audit_detail CHECK (
        action NOT IN ('validation_begin', 'validation_finish', 'validation_confirm', 'validation_fail')
        OR (jsonb_typeof(detail) = 'object' AND detail ? 'validationId'
          AND detail - 'validationId' = '{}'::jsonb
          AND jsonb_typeof(detail->'validationId') = 'string'
          AND length(detail->>'validationId') > 0)
      );
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Evidence is durable. Rollback is allowed only before the feature has been
  // used; it must never erase validation history or leave active proof dangling.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM integration_stock_prep_read_plan_validations)
        OR EXISTS (SELECT 1 FROM integration_stock_prep_read_plan_audit
          WHERE action IN ('validation_begin', 'validation_finish', 'validation_confirm', 'validation_fail'))
      THEN RAISE EXCEPTION 'READ_PLAN_VALIDATION_ROLLBACK_REQUIRES_EMPTY_LEDGER';
      END IF;
    END $$;
    ALTER TABLE integration_stock_prep_read_plan_activation DROP COLUMN validation_id;
    ALTER TABLE integration_stock_prep_read_plan_versions DROP COLUMN validation_id;
    DROP TABLE integration_stock_prep_read_plan_validations;
    ALTER TABLE integration_stock_prep_read_plan_audit
      DROP CONSTRAINT stock_prep_validation_audit_detail,
      DROP CONSTRAINT integration_stock_prep_read_plan_audit_action_check;
    ALTER TABLE integration_stock_prep_read_plan_audit
      ADD CONSTRAINT integration_stock_prep_read_plan_audit_action_check
      CHECK (action IN ('save_version', 'reuse_version', 'status_change', 'activate', 'deactivate'));
  `.execute(db)
}
