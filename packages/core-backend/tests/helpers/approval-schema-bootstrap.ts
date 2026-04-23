import { poolManager } from '../../src/integration/db/connection-pool'

const APPROVAL_SCHEMA_BOOTSTRAP_KEY = 'approval-schema-bootstrap'
const APPROVAL_SCHEMA_BOOTSTRAP_VERSION = '20260423-once-per-db'

/**
 * Ensures the approval schema (tables, constraints, indexes, sequences) is
 * materialized for the integration-test suite.
 *
 * The DDL body is the union of what the two approval integration test files
 * previously bootstrapped inline — which were byte-for-byte identical apart
 * from a comment block — and aligns with the production migrations:
 *   - 20250924105000_create_approval_tables.ts
 *   - zzzz20260404100000_extend_approval_tables_for_bridge.ts
 *   - zzzz20260411120100_approval_templates_and_instance_extensions.ts
 *   - zzzz20260411123000_add_created_action_to_approval_records.ts
 *
 * ### Concurrency — why an advisory lock
 *
 * When vitest runs multiple integration files in parallel workers, each
 * worker's `beforeAll` may enter this bootstrap simultaneously. The DDL
 * sequence contains idempotent-but-not-atomic patterns such as
 * `DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT`, and
 * `DROP INDEX IF EXISTS` followed by `CREATE UNIQUE INDEX`. Two concurrent
 * sessions can interleave so that session A's `DROP` and session B's `ADD`
 * race in `pg_class`, producing Postgres errors 42710 (duplicate_object) or
 * 23505 (unique violation on `pg_class`/`pg_constraint`).
 *
 * We serialize the entire DDL sequence with a session-scoped advisory lock and
 * a DB-persisted version marker. The advisory lock prevents concurrent
 * bootstraps from interleaving, while the marker prevents worker B from running
 * the same DDL after worker A has already committed and started its HTTP server.
 * That second phase matters because otherwise worker B's repeat ALTER/INDEX
 * statements can still deadlock with worker A's live API queries.
 *
 * The advisory lock is acquired inside a dedicated `pg.PoolClient` and released
 * automatically on `COMMIT` / `ROLLBACK` (that is what
 * `pg_advisory_xact_lock` does — as opposed to `pg_advisory_lock`, which would
 * require an explicit unlock).
 *
 * The lock key is `hashtext('approval-schema-bootstrap')` — int4 up-cast by
 * Postgres to int8 for the one-arg form of `pg_advisory_xact_lock`.
 *
 * ### Client-scope vs pool-scope
 *
 * Advisory locks are owned by the Postgres session (backend), not the pg
 * connection-pool abstraction. We call `.connect()` to pin a single backend
 * for the lifetime of the bootstrap so the lock acquisition and release stay
 * on the same session; issuing the DDL through `pool.query()` would let the
 * pool hand each statement to a different backend and defeat serialization.
 */
export async function ensureApprovalSchemaReady(): Promise<void> {
  const pool = poolManager.get().getInternalPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [APPROVAL_SCHEMA_BOOTSTRAP_KEY])

    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_test_schema_bootstrap_state (
        key TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const marker = await client.query<{ version: string }>(
      `SELECT version FROM approval_test_schema_bootstrap_state WHERE key = $1`,
      [APPROVAL_SCHEMA_BOOTSTRAP_KEY],
    )
    if (marker.rows[0]?.version === APPROVAL_SCHEMA_BOOTSTRAP_VERSION) {
      await client.query('COMMIT')
      return
    }

    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_instances (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_system TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS external_approval_id TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS workflow_key TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS business_key TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS title TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS requester_snapshot JSONB`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS subject_snapshot JSONB`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS policy_snapshot JSONB`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS metadata JSONB`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_step INTEGER`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS total_steps INTEGER`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_status TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_error TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_id UUID`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_version_id UUID`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS published_definition_id UUID`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS request_no TEXT`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS form_snapshot JSONB`)
    await client.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_node_key TEXT`)
    await client.query(`
      UPDATE approval_instances
      SET source_system = COALESCE(source_system, 'platform'),
          requester_snapshot = COALESCE(requester_snapshot, '{}'::jsonb),
          subject_snapshot = COALESCE(subject_snapshot, '{}'::jsonb),
          policy_snapshot = COALESCE(policy_snapshot, '{}'::jsonb),
          metadata = COALESCE(metadata, '{}'::jsonb),
          current_step = COALESCE(current_step, 0),
          total_steps = COALESCE(total_steps, 0),
          sync_status = COALESCE(sync_status, 'ok')
    `)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN source_system SET DEFAULT 'platform'`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN requester_snapshot SET DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN subject_snapshot SET DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN policy_snapshot SET DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN metadata SET DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN current_step SET DEFAULT 0`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN total_steps SET DEFAULT 0`)
    await client.query(`ALTER TABLE approval_instances ALTER COLUMN sync_status SET DEFAULT 'ok'`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_source_external ON approval_instances(source_system, external_approval_id) WHERE external_approval_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_status_updated ON approval_instances(status, updated_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_source_status ON approval_instances(source_system, status, updated_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_workflow_business ON approval_instances(workflow_key, business_key)`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_request_no ON approval_instances(request_no) WHERE request_no IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_template_status ON approval_instances(template_id, status, updated_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_published_definition ON approval_instances(published_definition_id)`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        comment TEXT NULL,
        reason TEXT NULL,
        from_status TEXT NULL,
        to_status TEXT NOT NULL,
        version INT NULL,
        from_version INT NULL,
        to_version INT NOT NULL DEFAULT 0,
        target_user_id TEXT NULL,
        target_step_id TEXT NULL,
        attachments JSONB DEFAULT '[]'::jsonb,
        metadata JSONB DEFAULT '{}'::jsonb,
        ip_address INET,
        user_agent TEXT,
        platform TEXT DEFAULT 'web',
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS actor_name TEXT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS reason TEXT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS version INT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS from_version INT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS to_version INT NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE approval_records ALTER COLUMN to_version SET DEFAULT 0`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_user_id TEXT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_step_id TEXT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS ip_address INET`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS user_agent TEXT`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'web'`)
    await client.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()`)
    await client.query(`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`)
    await client.query(`
      ALTER TABLE approval_records
      ADD CONSTRAINT approval_records_action_check
      CHECK (action IN ('created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_records_instance ON approval_records(instance_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_records_instance_action_time ON approval_records(instance_id, action, occurred_at DESC)`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
        assignment_type TEXT NOT NULL CHECK (assignment_type IN ('user', 'role', 'source_queue')),
        assignee_id TEXT NOT NULL,
        source_step INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`ALTER TABLE approval_assignments ADD COLUMN IF NOT EXISTS node_key TEXT`)
    await client.query(`
      DO $$
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
      END $$;
    `)
    await client.query(`DROP INDEX IF EXISTS idx_approval_assignments_active_unique`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_assignments_active_unique ON approval_assignments(instance_id, assignment_type, assignee_id) WHERE is_active = TRUE`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_assignments_lookup ON approval_assignments(assignment_type, assignee_id, is_active)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_assignments_instance ON approval_assignments(instance_id, is_active)`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        active_version_id UUID,
        latest_version_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_template_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        form_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
        approval_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (template_id, version)
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_published_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
        template_version_id UUID NOT NULL REFERENCES approval_template_versions(id) ON DELETE CASCADE,
        runtime_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE approval_templates
          ADD CONSTRAINT approval_templates_active_version_fk
          FOREIGN KEY (active_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE approval_templates
          ADD CONSTRAINT approval_templates_latest_version_fk
          FOREIGN KEY (latest_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_templates_status_updated ON approval_templates(status, updated_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_template_versions_template ON approval_template_versions(template_id, version DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_published_definitions_template_version ON approval_published_definitions(template_version_id, published_at DESC)`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_published_definitions_active_template ON approval_published_definitions(template_id) WHERE is_active = TRUE`)

    await client.query(`CREATE SEQUENCE IF NOT EXISTS approval_request_no_seq START WITH 100001 INCREMENT BY 1`)

    await client.query(
      `INSERT INTO approval_test_schema_bootstrap_state (key, version, completed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key)
       DO UPDATE SET version = EXCLUDED.version,
                     completed_at = EXCLUDED.completed_at`,
      [APPROVAL_SCHEMA_BOOTSTRAP_KEY, APPROVAL_SCHEMA_BOOTSTRAP_VERSION],
    )

    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // swallow rollback errors — the original error is more informative
    }
    throw error
  } finally {
    client.release()
  }
}
