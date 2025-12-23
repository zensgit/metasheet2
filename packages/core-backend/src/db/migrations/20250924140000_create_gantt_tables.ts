/**
 * Migration: Create Gantt chart tables
 * Timestamp: 2025-09-24 14:00:00
 */

import type { Kysely} from 'kysely';
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  // Create gantt_tasks table
  await db.schema
    .createTable('gantt_tasks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('view_id', 'uuid', (col) =>
      col.notNull().references('views.id').onDelete('cascade')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('start_date', 'date', (col) => col.notNull())
    .addColumn('end_date', 'date', (col) => col.notNull())
    .addColumn('progress', 'integer', (col) =>
      col.notNull().defaultTo(0).check(sql`progress >= 0 AND progress <= 100`)
    )
    .addColumn('parent_id', 'uuid', (col) =>
      col.references('gantt_tasks.id').onDelete('cascade')
    )
    .addColumn('order_index', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_milestone', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('priority', 'text', (col) =>
      col.check(sql`priority IN ('low', 'normal', 'high', 'critical')`)
    )
    .addColumn('assigned_to', 'uuid')
    .addColumn('estimated_hours', sql`numeric(8,2)`)
    .addColumn('actual_hours', sql`numeric(8,2)`)
    .addColumn('status', 'text', (col) =>
      col.notNull().defaultTo('not_started').check(sql`status IN ('not_started', 'in_progress', 'completed', 'cancelled', 'on_hold')`)
    )
    .addColumn('created_by', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute()

  // Create gantt_dependencies table
  await db.schema
    .createTable('gantt_dependencies')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('source_task_id', 'uuid', (col) =>
      col.notNull().references('gantt_tasks.id').onDelete('cascade')
    )
    .addColumn('target_task_id', 'uuid', (col) =>
      col.notNull().references('gantt_tasks.id').onDelete('cascade')
    )
    .addColumn('type', 'text', (col) =>
      col.notNull().defaultTo('finish_to_start').check(sql`type IN ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish')`)
    )
    .addColumn('lag_days', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute()

  // Create gantt_resources table for future resource management
  await db.schema
    .createTable('gantt_resources')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('view_id', 'uuid', (col) =>
      col.notNull().references('views.id').onDelete('cascade')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) =>
      col.notNull().check(sql`type IN ('person', 'equipment', 'material')`)
    )
    .addColumn('capacity', sql`numeric(8,2)`, (col) => col.notNull().defaultTo(100))
    .addColumn('cost_per_hour', sql`numeric(10,2)`)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute()

  // Create gantt_task_resources junction table
  await db.schema
    .createTable('gantt_task_resources')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('task_id', 'uuid', (col) =>
      col.notNull().references('gantt_tasks.id').onDelete('cascade')
    )
    .addColumn('resource_id', 'uuid', (col) =>
      col.notNull().references('gantt_resources.id').onDelete('cascade')
    )
    .addColumn('allocation_percent', 'integer', (col) =>
      col.notNull().defaultTo(100).check(sql`allocation_percent >= 0 AND allocation_percent <= 100`)
    )
    .addColumn('assigned_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute()

  // Create indexes for performance

  // Gantt tasks indexes
  await db.schema
    .createIndex('idx_gantt_tasks_view_id')
    .ifNotExists()
    .on('gantt_tasks')
    .column('view_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_tasks_parent_id')
    .ifNotExists()
    .on('gantt_tasks')
    .column('parent_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_tasks_dates')
    .ifNotExists()
    .on('gantt_tasks')
    .columns(['start_date', 'end_date'])
    .execute()

  await db.schema
    .createIndex('idx_gantt_tasks_status')
    .ifNotExists()
    .on('gantt_tasks')
    .column('status')
    .execute()

  await db.schema
    .createIndex('idx_gantt_tasks_assigned_to')
    .ifNotExists()
    .on('gantt_tasks')
    .column('assigned_to')
    .execute()

  // Dependencies indexes
  await db.schema
    .createIndex('idx_gantt_dependencies_source')
    .ifNotExists()
    .on('gantt_dependencies')
    .column('source_task_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_dependencies_target')
    .ifNotExists()
    .on('gantt_dependencies')
    .column('target_task_id')
    .execute()

  // Prevent circular dependencies constraint
  await db.schema
    .createIndex('idx_gantt_dependencies_unique')
    .ifNotExists()
    .on('gantt_dependencies')
    .columns(['source_task_id', 'target_task_id'])
    .unique()
    .execute()

  // Resources indexes
  await db.schema
    .createIndex('idx_gantt_resources_view_id')
    .ifNotExists()
    .on('gantt_resources')
    .column('view_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_resources_type')
    .ifNotExists()
    .on('gantt_resources')
    .column('type')
    .execute()

  // Task resources indexes
  await db.schema
    .createIndex('idx_gantt_task_resources_task_id')
    .ifNotExists()
    .on('gantt_task_resources')
    .column('task_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_task_resources_resource_id')
    .ifNotExists()
    .on('gantt_task_resources')
    .column('resource_id')
    .execute()

  await db.schema
    .createIndex('idx_gantt_task_resources_unique')
    .ifNotExists()
    .on('gantt_task_resources')
    .columns(['task_id', 'resource_id'])
    .unique()
    .execute()

  // Ensure updated_at trigger function exists before adding triggers.
  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db)

  // Add triggers for updated_at columns
  await sql`
    CREATE TRIGGER update_gantt_tasks_updated_at BEFORE UPDATE ON gantt_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db)

  await sql`
    CREATE TRIGGER update_gantt_resources_updated_at BEFORE UPDATE ON gantt_resources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db)

  // Add check constraint to prevent self-referencing dependencies
  await sql`
    ALTER TABLE gantt_dependencies
    ADD CONSTRAINT chk_no_self_dependency
    CHECK (source_task_id != target_task_id);
  `.execute(db)

  // Add check constraint for valid date range
  await sql`
    ALTER TABLE gantt_tasks
    ADD CONSTRAINT chk_valid_date_range
    CHECK (start_date <= end_date);
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers
  await sql`DROP TRIGGER IF EXISTS update_gantt_resources_updated_at ON gantt_resources`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_gantt_tasks_updated_at ON gantt_tasks`.execute(db)

  // Drop tables in reverse order (respecting foreign keys)
  await db.schema.dropTable('gantt_task_resources').ifExists().cascade().execute()
  await db.schema.dropTable('gantt_resources').ifExists().cascade().execute()
  await db.schema.dropTable('gantt_dependencies').ifExists().cascade().execute()
  await db.schema.dropTable('gantt_tasks').ifExists().cascade().execute()
}
