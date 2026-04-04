/**
 * Extend approval tables for the phase 1 PLM approval bridge.
 *
 * This keeps legacy platform approvals working while adding enough structure
 * to mirror PLM approvals into the shared approval inbox model.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const approvalInstanceColumns = [
  'sync_error',
  'sync_status',
  'last_synced_at',
  'source_updated_at',
  'total_steps',
  'current_step',
  'metadata',
  'policy_snapshot',
  'subject_snapshot',
  'requester_snapshot',
  'title',
  'business_key',
  'workflow_key',
  'external_approval_id',
  'source_system',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_system TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS external_approval_id TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS workflow_key TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS business_key TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS title TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS requester_snapshot JSONB`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS subject_snapshot JSONB`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS policy_snapshot JSONB`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS metadata JSONB`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_step INTEGER`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS total_steps INTEGER`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_status TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_error TEXT`.execute(db)

  await sql`UPDATE approval_instances
    SET source_system = COALESCE(source_system, 'platform'),
        requester_snapshot = COALESCE(requester_snapshot, '{}'::jsonb),
        subject_snapshot = COALESCE(subject_snapshot, '{}'::jsonb),
        policy_snapshot = COALESCE(policy_snapshot, '{}'::jsonb),
        metadata = COALESCE(metadata, '{}'::jsonb),
        current_step = COALESCE(current_step, 0),
        total_steps = COALESCE(total_steps, 0),
        sync_status = COALESCE(sync_status, 'ok')`.execute(db)

  await sql`ALTER TABLE approval_instances ALTER COLUMN source_system SET DEFAULT 'platform'`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN requester_snapshot SET DEFAULT '{}'::jsonb`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN subject_snapshot SET DEFAULT '{}'::jsonb`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN policy_snapshot SET DEFAULT '{}'::jsonb`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN metadata SET DEFAULT '{}'::jsonb`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN current_step SET DEFAULT 0`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN total_steps SET DEFAULT 0`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN sync_status SET DEFAULT 'ok'`.execute(db)

  await sql`ALTER TABLE approval_instances ALTER COLUMN source_system SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN requester_snapshot SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN subject_snapshot SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN policy_snapshot SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN metadata SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN current_step SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN total_steps SET NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ALTER COLUMN sync_status SET NOT NULL`.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_source_external
    ON approval_instances(source_system, external_approval_id)
    WHERE external_approval_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_instances_status_updated
    ON approval_instances(status, updated_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_instances_source_status
    ON approval_instances(source_system, status, updated_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_instances_workflow_business
    ON approval_instances(workflow_key, business_key)`.execute(db)

  await sql`CREATE TABLE IF NOT EXISTS approval_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
    assignment_type TEXT NOT NULL CHECK (assignment_type IN ('user', 'role', 'source_queue')),
    assignee_id TEXT NOT NULL,
    source_step INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instance_id, assignment_type, assignee_id, source_step)
  )`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_approval_assignments_lookup
    ON approval_assignments(assignment_type, assignee_id, is_active)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_assignments_instance
    ON approval_assignments(instance_id, is_active)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_assignments CASCADE`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_workflow_business`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_source_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_status_updated`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_source_external`.execute(db)

  for (const column of approvalInstanceColumns) {
    await sql.raw(`ALTER TABLE approval_instances DROP COLUMN IF EXISTS ${column}`).execute(db)
  }
}
