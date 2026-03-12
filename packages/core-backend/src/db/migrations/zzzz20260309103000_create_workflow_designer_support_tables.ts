import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const workflowDefinitionsExists = await checkTableExists(db, 'workflow_definitions')
  if (!workflowDefinitionsExists) {
    await db.schema
      .createTable('workflow_definitions')
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'varchar(255)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('definition', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('status', 'varchar(50)', (col) => col.notNull().defaultTo('draft'))
      .addColumn('created_by', 'varchar(255)', (col) => col.notNull().defaultTo('system'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute()

    await db.schema
      .createIndex('idx_workflow_definitions_status')
      .ifNotExists()
      .on('workflow_definitions')
      .column('status')
      .execute()

    await db.schema
      .createIndex('idx_workflow_definitions_updated_at')
      .ifNotExists()
      .on('workflow_definitions')
      .column('updated_at')
      .execute()

    await db.schema
      .createIndex('idx_workflow_definitions_created_by')
      .ifNotExists()
      .on('workflow_definitions')
      .column('created_by')
      .execute()
  }

  const workflowTemplatesExists = await checkTableExists(db, 'workflow_templates')
  if (!workflowTemplatesExists) {
    await db.schema
      .createTable('workflow_templates')
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'varchar(255)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('category', 'varchar(100)', (col) => col.notNull().defaultTo('general'))
      .addColumn('template_definition', 'text')
      .addColumn('required_variables', 'text')
      .addColumn('optional_variables', 'text')
      .addColumn('tags', 'text')
      .addColumn('is_public', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('is_featured', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('usage_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_by', 'varchar(255)', (col) => col.notNull().defaultTo('system'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute()

    await db.schema
      .createIndex('idx_workflow_templates_public_featured')
      .ifNotExists()
      .on('workflow_templates')
      .columns(['is_public', 'is_featured'])
      .execute()

    await db.schema
      .createIndex('idx_workflow_templates_usage_count')
      .ifNotExists()
      .on('workflow_templates')
      .column('usage_count')
      .execute()

    await db.schema
      .createIndex('idx_workflow_templates_updated_at')
      .ifNotExists()
      .on('workflow_templates')
      .column('updated_at')
      .execute()
  }

  const workflowNodeLibraryExists = await checkTableExists(db, 'workflow_node_library')
  if (!workflowNodeLibraryExists) {
    await db.schema
      .createTable('workflow_node_library')
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('node_type', 'varchar(100)', (col) => col.notNull())
      .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
      .addColumn('category', 'varchar(100)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('properties_schema', 'text')
      .addColumn('default_properties', 'text')
      .addColumn('validation_rules', 'text')
      .addColumn('visual_config', 'text')
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute()

    await db.schema
      .createIndex('idx_workflow_node_library_active')
      .ifNotExists()
      .on('workflow_node_library')
      .column('is_active')
      .execute()
  }

  const workflowAnalyticsExists = await checkTableExists(db, 'workflow_analytics')
  if (!workflowAnalyticsExists) {
    await db.schema
      .createTable('workflow_analytics')
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('workflow_id', 'uuid', (col) => col.notNull())
      .addColumn('event_type', 'varchar(100)', (col) => col.notNull())
      .addColumn('user_id', 'varchar(255)')
      .addColumn('event_data', 'text')
      .addColumn('recorded_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute()

    await db.schema
      .createIndex('idx_workflow_analytics_workflow_id')
      .ifNotExists()
      .on('workflow_analytics')
      .column('workflow_id')
      .execute()

    await db.schema
      .createIndex('idx_workflow_analytics_recorded_at')
      .ifNotExists()
      .on('workflow_analytics')
      .column('recorded_at')
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('workflow_analytics').ifExists().execute()
  await db.schema.dropTable('workflow_node_library').ifExists().execute()
  await db.schema.dropTable('workflow_templates').ifExists().execute()
  await db.schema.dropTable('workflow_definitions').ifExists().execute()
}
