import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await db.schema
    .createTable('bpmn_process_definitions')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'varchar(255)', col => col.notNull())
    .addColumn('name', 'varchar(255)', col => col.notNull())
    .addColumn('version', 'integer', col => col.notNull())
    .addColumn('bpmn_xml', 'text', col => col.notNull())
    .addColumn('deployment_id', 'varchar(255)')
    .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('category', 'varchar(255)')
    .addColumn('diagram_json', 'text')
    .addColumn('tenant_id', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_definitions_key')
    .ifNotExists()
    .on('bpmn_process_definitions')
    .column('key')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_definitions_tenant')
    .ifNotExists()
    .on('bpmn_process_definitions')
    .column('tenant_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_definitions_active')
    .ifNotExists()
    .on('bpmn_process_definitions')
    .column('is_active')
    .execute()

  await db.schema
    .createTable('bpmn_process_instances')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_definition_id', 'uuid', col => col.notNull())
    .addColumn('process_definition_key', 'varchar(255)')
    .addColumn('business_key', 'varchar(255)')
    .addColumn('parent_process_instance_id', 'uuid')
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('start_time', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('end_time', 'timestamptz')
    .addColumn('variables', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('tenant_id', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_instances_state')
    .ifNotExists()
    .on('bpmn_process_instances')
    .column('state')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_instances_definition')
    .ifNotExists()
    .on('bpmn_process_instances')
    .column('process_definition_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_instances_key')
    .ifNotExists()
    .on('bpmn_process_instances')
    .column('process_definition_key')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_process_instances_tenant')
    .ifNotExists()
    .on('bpmn_process_instances')
    .column('tenant_id')
    .execute()

  await db.schema
    .createTable('bpmn_activity_instances')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('activity_id', 'varchar(255)', col => col.notNull())
    .addColumn('activity_type', 'varchar(100)', col => col.notNull())
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('start_time', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('end_time', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_activity_instances_process')
    .ifNotExists()
    .on('bpmn_activity_instances')
    .column('process_instance_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_activity_instances_state')
    .ifNotExists()
    .on('bpmn_activity_instances')
    .column('state')
    .execute()

  await db.schema
    .createTable('bpmn_user_tasks')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('activity_instance_id', 'uuid', col => col.notNull())
    .addColumn('task_definition_key', 'varchar(255)', col => col.notNull())
    .addColumn('name', 'varchar(255)')
    .addColumn('assignee', 'varchar(255)')
    .addColumn('candidate_groups', 'jsonb')
    .addColumn('candidate_users', 'jsonb')
    .addColumn('due_date', 'timestamptz')
    .addColumn('follow_up_date', 'timestamptz')
    .addColumn('priority', 'integer')
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('completed_at', 'timestamptz')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_user_tasks_process')
    .ifNotExists()
    .on('bpmn_user_tasks')
    .column('process_instance_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_user_tasks_assignee')
    .ifNotExists()
    .on('bpmn_user_tasks')
    .column('assignee')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_user_tasks_state')
    .ifNotExists()
    .on('bpmn_user_tasks')
    .column('state')
    .execute()

  await db.schema
    .createTable('bpmn_message_events')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('message_name', 'varchar(255)', col => col.notNull())
    .addColumn('correlation_key', 'varchar(255)')
    .addColumn('process_instance_id', 'uuid')
    .addColumn('payload', 'jsonb')
    .addColumn('status', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_message_events_name')
    .ifNotExists()
    .on('bpmn_message_events')
    .column('message_name')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_message_events_status')
    .ifNotExists()
    .on('bpmn_message_events')
    .column('status')
    .execute()

  await db.schema
    .createTable('bpmn_signal_events')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('signal_name', 'varchar(255)', col => col.notNull())
    .addColumn('process_instance_id', 'uuid')
    .addColumn('payload', 'jsonb')
    .addColumn('status', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_signal_events_name')
    .ifNotExists()
    .on('bpmn_signal_events')
    .column('signal_name')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_signal_events_status')
    .ifNotExists()
    .on('bpmn_signal_events')
    .column('status')
    .execute()

  await db.schema
    .createTable('bpmn_variables')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('name', 'varchar(255)', col => col.notNull())
    .addColumn('value', 'jsonb')
    .addColumn('type', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_variables_instance')
    .ifNotExists()
    .on('bpmn_variables')
    .columns(['process_instance_id', 'name'])
    .execute()

  await db.schema
    .createIndex('idx_bpmn_variables_unique')
    .ifNotExists()
    .unique()
    .on('bpmn_variables')
    .columns(['name', 'process_instance_id'])
    .execute()

  await db.schema
    .createTable('bpmn_incidents')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('activity_instance_id', 'uuid')
    .addColumn('incident_type', 'varchar(100)', col => col.notNull())
    .addColumn('message', 'text', col => col.notNull())
    .addColumn('stack_trace', 'text')
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('resolved_at', 'timestamptz')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_incidents_process')
    .ifNotExists()
    .on('bpmn_incidents')
    .column('process_instance_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_incidents_state')
    .ifNotExists()
    .on('bpmn_incidents')
    .column('state')
    .execute()

  await db.schema
    .createTable('bpmn_external_tasks')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('activity_instance_id', 'uuid', col => col.notNull())
    .addColumn('topic_name', 'varchar(255)', col => col.notNull())
    .addColumn('worker_id', 'varchar(255)')
    .addColumn('lock_expiration_time', 'timestamptz')
    .addColumn('retries', 'integer')
    .addColumn('error_message', 'text')
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_external_tasks_topic')
    .ifNotExists()
    .on('bpmn_external_tasks')
    .column('topic_name')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_external_tasks_lock')
    .ifNotExists()
    .on('bpmn_external_tasks')
    .column('lock_expiration_time')
    .execute()

  await db.schema
    .createTable('bpmn_timer_jobs')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid', col => col.notNull())
    .addColumn('activity_instance_id', 'uuid')
    .addColumn('timer_type', 'varchar(50)', col => col.notNull())
    .addColumn('due_date', 'timestamptz', col => col.notNull())
    .addColumn('repeat_count', 'integer')
    .addColumn('repeat_interval', 'varchar(100)')
    .addColumn('state', 'varchar(50)', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_timer_jobs_due')
    .ifNotExists()
    .on('bpmn_timer_jobs')
    .column('due_date')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_timer_jobs_state')
    .ifNotExists()
    .on('bpmn_timer_jobs')
    .column('state')
    .execute()

  await db.schema
    .createTable('bpmn_audit_log')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('process_instance_id', 'uuid')
    .addColumn('task_id', 'uuid')
    .addColumn('user_id', 'varchar(255)')
    .addColumn('action', 'varchar(100)')
    .addColumn('old_value', 'text')
    .addColumn('new_value', 'text')
    .addColumn('timestamp', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_bpmn_audit_log_process')
    .ifNotExists()
    .on('bpmn_audit_log')
    .column('process_instance_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_audit_log_task')
    .ifNotExists()
    .on('bpmn_audit_log')
    .column('task_id')
    .execute()

  await db.schema
    .createIndex('idx_bpmn_audit_log_time')
    .ifNotExists()
    .on('bpmn_audit_log')
    .column('timestamp')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('bpmn_audit_log').ifExists().execute()
  await db.schema.dropTable('bpmn_timer_jobs').ifExists().execute()
  await db.schema.dropTable('bpmn_external_tasks').ifExists().execute()
  await db.schema.dropTable('bpmn_incidents').ifExists().execute()
  await db.schema.dropTable('bpmn_variables').ifExists().execute()
  await db.schema.dropTable('bpmn_signal_events').ifExists().execute()
  await db.schema.dropTable('bpmn_message_events').ifExists().execute()
  await db.schema.dropTable('bpmn_user_tasks').ifExists().execute()
  await db.schema.dropTable('bpmn_activity_instances').ifExists().execute()
  await db.schema.dropTable('bpmn_process_instances').ifExists().execute()
  await db.schema.dropTable('bpmn_process_definitions').ifExists().execute()
}
