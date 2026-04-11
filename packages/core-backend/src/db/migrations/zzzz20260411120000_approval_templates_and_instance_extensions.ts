import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const approvalInstanceColumns = [
  'current_node_key',
  'form_snapshot',
  'request_no',
  'published_definition_id',
  'template_version_id',
  'template_id',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`CREATE TABLE IF NOT EXISTS approval_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    active_version_id UUID,
    latest_version_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db)

  await sql`CREATE TABLE IF NOT EXISTS approval_template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    form_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    approval_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
  )`.execute(db)

  await sql`CREATE TABLE IF NOT EXISTS approval_published_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
    template_version_id UUID NOT NULL REFERENCES approval_template_versions(id) ON DELETE CASCADE,
    runtime_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db)

  await sql`ALTER TABLE approval_templates
    ADD CONSTRAINT approval_templates_active_version_fk
    FOREIGN KEY (active_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL`.execute(db).catch(() => undefined)

  await sql`ALTER TABLE approval_templates
    ADD CONSTRAINT approval_templates_latest_version_fk
    FOREIGN KEY (latest_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL`.execute(db).catch(() => undefined)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_templates_key
    ON approval_templates(key)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_templates_status_updated
    ON approval_templates(status, updated_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_template_versions_template
    ON approval_template_versions(template_id, version DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_published_definitions_template_version
    ON approval_published_definitions(template_version_id, published_at DESC)`.execute(db)
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_published_definitions_active_template
    ON approval_published_definitions(template_id)
    WHERE is_active = TRUE`.execute(db)

  await sql`CREATE SEQUENCE IF NOT EXISTS approval_request_no_seq START WITH 100001 INCREMENT BY 1`.execute(db)

  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES approval_templates(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_version_id UUID REFERENCES approval_template_versions(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS published_definition_id UUID REFERENCES approval_published_definitions(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS request_no TEXT`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS form_snapshot JSONB`.execute(db)
  await sql`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_node_key TEXT`.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_request_no
    ON approval_instances(request_no)
    WHERE request_no IS NOT NULL`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_instances_template_status
    ON approval_instances(template_id, status, updated_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_instances_published_definition
    ON approval_instances(published_definition_id)`.execute(db)

  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))`.execute(db)

  await sql`ALTER TABLE approval_assignments ADD COLUMN IF NOT EXISTS node_key TEXT`.execute(db)

  await sql`DO $$
  DECLARE
    record_row RECORD;
  BEGIN
    FOR record_row IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'approval_assignments'::regclass
        AND contype = 'u'
    LOOP
      EXECUTE format('ALTER TABLE approval_assignments DROP CONSTRAINT IF EXISTS %I', record_row.conname);
    END LOOP;
  END$$`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_approval_assignments_active_unique`.execute(db)
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_assignments_active_unique
    ON approval_assignments(instance_id, assignment_type, assignee_id)
    WHERE is_active = TRUE`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_assignments_active_unique`.execute(db)
  await sql`ALTER TABLE approval_assignments DROP COLUMN IF EXISTS node_key`.execute(db)

  await sql`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`.execute(db)
  await sql`ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('approve', 'reject', 'return', 'revoke', 'transfer', 'sign'))`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_approval_instances_published_definition`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_template_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_instances_request_no`.execute(db)

  for (const column of approvalInstanceColumns) {
    await sql.raw(`ALTER TABLE approval_instances DROP COLUMN IF EXISTS ${column}`).execute(db)
  }

  await sql`DROP SEQUENCE IF EXISTS approval_request_no_seq`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_approval_published_definitions_active_template`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_published_definitions_template_version`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_template_versions_template`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_templates_status_updated`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_templates_key`.execute(db)

  await sql`DROP TABLE IF EXISTS approval_published_definitions CASCADE`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_template_versions CASCADE`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_templates CASCADE`.execute(db)
}
