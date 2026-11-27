import { sql, type Kysely } from 'kysely'

// 101's full vocabulary. Keep this local to the migration so future application changes cannot
// silently change what a replay or rollback installs. Migration 066 owns the append-only trail.
const priorActions = [
  'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire', 'unit_confirm', 'unit_retire',
  'generation_run', 'exception_resolve', 'exception_bulk_resolve', 'persist_repair_once',
  'source_binding_set', 'prep_line_export', 'project_directory_read', 'handoff_advance',
  'project_board_read', 'project_target_create', 'project_target_archive', 'project_target_restore',
  'project_target_grant', 'project_fields_update', 'project_overview_refresh', 'project_pilot_enable',
] as const

async function replaceAuditCheck(db: Kysely<unknown>, actions: readonly string[]) {
  await sql`ALTER TABLE integration_stock_prep_audit
    DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check`.execute(db)
  await sql`ALTER TABLE integration_stock_prep_audit
    ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK (action IN (
      ${sql.join(actions.map(action => sql.lit(action)))}
    ))`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceAuditCheck(db, [...priorActions, 'project_delete'])
  await sql`CREATE TABLE integration_stock_prep_project_delete_challenges (
    id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    project_no text NOT NULL,
    actor text NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    code_digest text NOT NULL CHECK (code_digest ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz NOT NULL,
    UNIQUE (tenant_id, project_no, actor)
  )`.execute(db)
  await sql`CREATE INDEX stock_prep_project_delete_challenge_expiry
    ON integration_stock_prep_project_delete_challenges (expires_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const evidence = await sql<{ present: boolean }>`SELECT EXISTS (
    SELECT 1 FROM integration_stock_prep_audit WHERE action = 'project_delete'
  ) AS present`.execute(db)
  if (evidence.rows[0]?.present !== false) throw new Error('STOCK_PREPARATION_PROJECT_DELETE_AUDIT_PRESENT')
  await replaceAuditCheck(db, priorActions)
  // Outstanding confirmations are ephemeral and must not survive disabling the feature.
  await sql`DROP TABLE integration_stock_prep_project_delete_challenges`.execute(db)
}
