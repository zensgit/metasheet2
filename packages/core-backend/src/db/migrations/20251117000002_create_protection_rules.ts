/**
 * Migration: Create protection_rules table
 *
 * Protection rules engine for dynamic SafetyGuard behavior
 * based on snapshot properties and operations.
 */

import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create protection_rules table
  await db.schema
    .createTable('protection_rules')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('rule_name', 'text', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('target_type', 'text', (col) => col.notNull().defaultTo('snapshot'))
    .addColumn('conditions', 'jsonb', (col) => col.notNull())
    .addColumn('effects', 'jsonb', (col) => col.notNull())
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(100))
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .addColumn('last_evaluated_at', 'timestamptz')
    .addColumn('evaluation_count', 'integer', (col) => col.defaultTo(0))
    .execute();

  // Create indexes for query performance
  await sql`CREATE INDEX idx_protection_rules_active ON protection_rules(is_active, priority DESC)`.execute(
    db
  );
  await sql`CREATE INDEX idx_protection_rules_target ON protection_rules(target_type)`.execute(
    db
  );
  await sql`CREATE INDEX idx_protection_rules_created_by ON protection_rules(created_by)`.execute(
    db
  );

  // Create GIN index for JSONB conditions
  await sql`CREATE INDEX idx_protection_rules_conditions ON protection_rules USING GIN(conditions)`.execute(
    db
  );

  // Add check constraint
  await sql`ALTER TABLE protection_rules ADD CONSTRAINT chk_target_type CHECK (target_type IN ('snapshot', 'plugin', 'schema', 'workflow'))`.execute(
    db
  );

  // Create rule_execution_log table for audit
  await db.schema
    .createTable('rule_execution_log')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('rule_id', 'text', (col) => col.notNull())
    .addColumn('rule_version', 'integer', (col) => col.notNull())
    .addColumn('entity_type', 'text', (col) => col.notNull())
    .addColumn('entity_id', 'text', (col) => col.notNull())
    .addColumn('operation', 'text', (col) => col.notNull())
    .addColumn('matched', 'boolean', (col) => col.notNull())
    .addColumn('effect_applied', 'jsonb')
    .addColumn('execution_time_ms', 'integer')
    .addColumn('executed_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute();

  await sql`CREATE INDEX idx_rule_execution_log_rule ON rule_execution_log(rule_id, executed_at DESC)`.execute(
    db
  );
  await sql`CREATE INDEX idx_rule_execution_log_entity ON rule_execution_log(entity_type, entity_id)`.execute(
    db
  );

  console.log('✅ Created protection_rules and rule_execution_log tables');
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop audit log table
  await db.schema.dropTable('rule_execution_log').ifExists().execute();

  // Drop protection_rules table
  await db.schema.dropTable('protection_rules').ifExists().execute();

  console.log('✅ Dropped protection rules tables');
}
