import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Update snapshots table
  await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS change_type text`.execute(db)
  await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS parent_snapshot_id text REFERENCES snapshots(id)`.execute(db)

  // 2. Create change_requests table
  await db.schema
    .createTable('change_requests')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('snapshot_id', 'text', (col) => col.notNull().references('snapshots.id'))
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('change_type', 'text', (col) => col.notNull())
    .addColumn('target_environment', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.defaultTo('pending'))
    .addColumn('requested_by', 'text', (col) => col.notNull())
    .addColumn('requested_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('approvers', sql`text[]`, (col) => col.defaultTo(sql`'{}'`))
    .addColumn('required_approvals', 'integer', (col) => col.defaultTo(1))
    .addColumn('current_approvals', 'integer', (col) => col.defaultTo(0))
    .addColumn('deployed_at', 'timestamptz')
    .addColumn('deployed_by', 'text')
    .addColumn('rolled_back_at', 'timestamptz')
    .addColumn('rolled_back_by', 'text')
    .addColumn('rollback_reason', 'text')
    .addColumn('auto_generated_notes', 'text')
    .addColumn('risk_score', 'float8', (col) => col.defaultTo(0.0))
    .addColumn('impact_assessment', 'jsonb', (col) => col.defaultTo(sql`'{}'`))
    .addColumn('metadata', 'jsonb', (col) => col.defaultTo(sql`'{}'`))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_cr_status ON change_requests(status)`.execute(db)
  await sql`CREATE INDEX idx_cr_environment ON change_requests(target_environment)`.execute(db)
  await sql`CREATE INDEX idx_cr_requested_by ON change_requests(requested_by)`.execute(db)

  // 3. Create change_approvals table
  await db.schema
    .createTable('change_approvals')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('change_request_id', 'text', (col) => col.notNull().references('change_requests.id'))
    .addColumn('approver_id', 'text', (col) => col.notNull())
    .addColumn('decision', 'text', (col) => col.notNull())
    .addColumn('comment', 'text')
    .addColumn('approved_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_ca_request ON change_approvals(change_request_id)`.execute(db)

  // 4. Create change_history table
  await db.schema
    .createTable('change_history')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('entity_type', 'text', (col) => col.notNull())
    .addColumn('entity_id', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'text', (col) => col.notNull())
    .addColumn('change_request_id', 'text', (col) => col.references('change_requests.id'))
    .addColumn('before_state', 'jsonb')
    .addColumn('after_state', 'jsonb')
    .addColumn('diff_summary', 'text')
    .addColumn('timestamp', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_ch_entity ON change_history(entity_type, entity_id)`.execute(db)
  await sql`CREATE INDEX idx_ch_timestamp ON change_history(timestamp)`.execute(db)

  // 5. Create schema_snapshots table
  await db.schema
    .createTable('schema_snapshots')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('view_id', 'text', (col) => col.notNull())
    .addColumn('schema_version', 'text', (col) => col.notNull())
    .addColumn('schema_definition', 'jsonb', (col) => col.notNull())
    .addColumn('validation_rules', 'jsonb', (col) => col.defaultTo(sql`'{}'`))
    .addColumn('migration_script', 'text')
    .addColumn('rollback_script', 'text')
    .addColumn('is_current', 'boolean', (col) => col.defaultTo(false))
    .addColumn('created_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_ss_view ON schema_snapshots(view_id)`.execute(db)
  await sql`CREATE INDEX idx_ss_current ON schema_snapshots(is_current) WHERE is_current = true`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('schema_snapshots').execute()
  await db.schema.dropTable('change_history').execute()
  await db.schema.dropTable('change_approvals').execute()
  await db.schema.dropTable('change_requests').execute()
  
  await sql`ALTER TABLE snapshots DROP COLUMN IF EXISTS parent_snapshot_id`.execute(db)
  await sql`ALTER TABLE snapshots DROP COLUMN IF EXISTS change_type`.execute(db)
}
