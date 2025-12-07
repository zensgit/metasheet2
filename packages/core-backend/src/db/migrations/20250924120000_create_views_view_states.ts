/**
 * Migration: Create Multi-View System Tables
 * Timestamp: 2025-09-24 12:00:00
 *
 * Purpose: Create core tables for multi-view system (Grid, Kanban, Calendar, Gallery, Form)
 * Tables: tables, views, view_states, kanban_configs, calendar_configs, gallery_configs,
 *         form_configs, form_responses, view_permissions, view_activity
 *
 * Based on Baserow/SeaTable architecture
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Ensure pgcrypto extension for gen_random_uuid()
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  // ============================================
  // 1. Create 'tables' table (base table definitions)
  // ============================================
  const tablesExists = await checkTableExists(db, 'tables')
  if (!tablesExists) {
    console.log('[Migration] Creating table: tables')
    await db.schema
      .createTable('tables')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'varchar(255)', col => col.notNull())
      .addColumn('description', 'text')
      .addColumn('schema', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('owner_id', 'integer')
      .addColumn('workspace_id', 'uuid')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('deleted_at', 'timestamptz')
      .execute()

    // Unique constraint on name, workspace_id, deleted_at
    await sql`
      ALTER TABLE tables ADD CONSTRAINT tables_name_workspace_unique
      UNIQUE (name, workspace_id, deleted_at)
    `.execute(db)
  }

  // ============================================
  // 2. Create 'views' table
  // ============================================
  const viewsExists = await checkTableExists(db, 'views')
  if (!viewsExists) {
    console.log('[Migration] Creating table: views')
    await db.schema
      .createTable('views')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('table_id', 'uuid', col => col.references('tables.id').onDelete('cascade'))
      .addColumn('type', 'varchar(50)', col => col.notNull())
      .addColumn('name', 'varchar(255)', col => col.notNull())
      .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('filters', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('sorting', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('visible_fields', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('is_default', 'boolean', col => col.defaultTo(false))
      .addColumn('is_public', 'boolean', col => col.defaultTo(false))
      .addColumn('created_by', 'integer')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('deleted_at', 'timestamptz')
      .execute()

    // Check constraint for view type
    await sql`
      ALTER TABLE views ADD CONSTRAINT views_type_check
      CHECK (type IN ('grid', 'kanban', 'calendar', 'gallery', 'form'))
    `.execute(db)
  }

  // ============================================
  // 3. Create 'view_states' table (user-specific personalization)
  // ============================================
  const viewStatesExists = await checkTableExists(db, 'view_states')
  if (!viewStatesExists) {
    console.log('[Migration] Creating table: view_states')
    await db.schema
      .createTable('view_states')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('view_id', 'uuid', col => col.references('views.id').onDelete('cascade'))
      .addColumn('user_id', 'integer')
      .addColumn('state', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('last_accessed', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .execute()

    // Unique constraint on view_id, user_id
    await sql`
      ALTER TABLE view_states ADD CONSTRAINT view_states_view_user_unique
      UNIQUE (view_id, user_id)
    `.execute(db)
  }

  // ============================================
  // 4. Create 'kanban_configs' table
  // ============================================
  const kanbanConfigsExists = await checkTableExists(db, 'kanban_configs')
  if (!kanbanConfigsExists) {
    console.log('[Migration] Creating table: kanban_configs')
    await db.schema
      .createTable('kanban_configs')
      .ifNotExists()
      .addColumn('view_id', 'uuid', col => col.primaryKey().references('views.id').onDelete('cascade'))
      .addColumn('group_by_field', 'varchar(255)', col => col.notNull())
      .addColumn('swimlanes_field', 'varchar(255)')
      .addColumn('card_fields', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('card_cover_field', 'varchar(255)')
      .addColumn('show_empty_groups', 'boolean', col => col.defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .execute()
  }

  // ============================================
  // 5. Create 'calendar_configs' table
  // ============================================
  const calendarConfigsExists = await checkTableExists(db, 'calendar_configs')
  if (!calendarConfigsExists) {
    console.log('[Migration] Creating table: calendar_configs')
    await db.schema
      .createTable('calendar_configs')
      .ifNotExists()
      .addColumn('view_id', 'uuid', col => col.primaryKey().references('views.id').onDelete('cascade'))
      .addColumn('date_field', 'varchar(255)', col => col.notNull())
      .addColumn('end_date_field', 'varchar(255)')
      .addColumn('title_field', 'varchar(255)', col => col.notNull())
      .addColumn('time_zone', 'varchar(50)', col => col.defaultTo('UTC'))
      .addColumn('default_view', 'varchar(20)', col => col.defaultTo('month'))
      .addColumn('week_starts_on', 'smallint', col => col.defaultTo(1))
      .addColumn('color_rules', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .execute()

    // Check constraints
    await sql`
      ALTER TABLE calendar_configs ADD CONSTRAINT calendar_default_view_check
      CHECK (default_view IN ('month', 'week', 'day', 'list'))
    `.execute(db)
    await sql`
      ALTER TABLE calendar_configs ADD CONSTRAINT calendar_week_starts_check
      CHECK (week_starts_on IN (0, 1))
    `.execute(db)
  }

  // ============================================
  // 6. Create 'gallery_configs' table
  // ============================================
  const galleryConfigsExists = await checkTableExists(db, 'gallery_configs')
  if (!galleryConfigsExists) {
    console.log('[Migration] Creating table: gallery_configs')
    await db.schema
      .createTable('gallery_configs')
      .ifNotExists()
      .addColumn('view_id', 'uuid', col => col.primaryKey().references('views.id').onDelete('cascade'))
      .addColumn('cover_field', 'varchar(255)')
      .addColumn('title_field', 'varchar(255)', col => col.notNull())
      .addColumn('fields_to_show', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('columns', 'integer', col => col.defaultTo(3))
      .addColumn('card_size', 'varchar(20)', col => col.defaultTo('medium'))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .execute()

    // Check constraints
    await sql`
      ALTER TABLE gallery_configs ADD CONSTRAINT gallery_columns_check
      CHECK (columns BETWEEN 2 AND 6)
    `.execute(db)
    await sql`
      ALTER TABLE gallery_configs ADD CONSTRAINT gallery_card_size_check
      CHECK (card_size IN ('small', 'medium', 'large'))
    `.execute(db)
  }

  // ============================================
  // 7. Create 'form_configs' table
  // ============================================
  const formConfigsExists = await checkTableExists(db, 'form_configs')
  if (!formConfigsExists) {
    console.log('[Migration] Creating table: form_configs')
    await db.schema
      .createTable('form_configs')
      .ifNotExists()
      .addColumn('view_id', 'uuid', col => col.primaryKey().references('views.id').onDelete('cascade'))
      .addColumn('title', 'varchar(255)', col => col.notNull())
      .addColumn('description', 'text')
      .addColumn('field_layout', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('submit_button_text', 'varchar(100)', col => col.defaultTo('Submit'))
      .addColumn('success_message', 'text')
      .addColumn('allow_multiple_submissions', 'boolean', col => col.defaultTo(false))
      .addColumn('require_auth', 'boolean', col => col.defaultTo(false))
      .addColumn('enable_public_access', 'boolean', col => col.defaultTo(true))
      .addColumn('redirect_url', 'varchar(500)')
      .addColumn('notification_emails', 'jsonb', col => col.defaultTo(sql`'[]'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .execute()
  }

  // ============================================
  // 8. Create 'form_responses' table
  // ============================================
  const formResponsesExists = await checkTableExists(db, 'form_responses')
  if (!formResponsesExists) {
    console.log('[Migration] Creating table: form_responses')
    await db.schema
      .createTable('form_responses')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('view_id', 'uuid', col => col.references('views.id').onDelete('cascade'))
      .addColumn('data', 'jsonb', col => col.notNull())
      .addColumn('submitted_by', 'integer')
      .addColumn('ip_address', sql`inet`)
      .addColumn('user_agent', 'text')
      .addColumn('submitted_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('status', 'varchar(20)', col => col.defaultTo('submitted'))
      .execute()

    await sql`
      ALTER TABLE form_responses ADD CONSTRAINT form_responses_status_check
      CHECK (status IN ('submitted', 'processed', 'archived'))
    `.execute(db)
  }

  // ============================================
  // 9. Create 'view_permissions' table
  // ============================================
  const viewPermissionsExists = await checkTableExists(db, 'view_permissions')
  if (!viewPermissionsExists) {
    console.log('[Migration] Creating table: view_permissions')
    await db.schema
      .createTable('view_permissions')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('view_id', 'uuid', col => col.references('views.id').onDelete('cascade'))
      .addColumn('user_id', 'integer')
      .addColumn('role_id', 'text')
      .addColumn('permission', 'varchar(20)', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`NOW()`))
      .addColumn('created_by', 'integer')
      .execute()

    await sql`
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_permission_check
      CHECK (permission IN ('read', 'write', 'admin'))
    `.execute(db)

    await sql`
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_unique
      UNIQUE (view_id, user_id, role_id)
    `.execute(db)

    await sql`
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_user_or_role
      CHECK ((user_id IS NOT NULL AND role_id IS NULL) OR (user_id IS NULL AND role_id IS NOT NULL))
    `.execute(db)
  }

  // ============================================
  // 10. Create indexes
  // ============================================
  console.log('[Migration] Creating indexes...')

  // Tables indexes
  await db.schema.createIndex('idx_tables_owner').ifNotExists().on('tables').column('owner_id').execute()
  await db.schema.createIndex('idx_tables_workspace').ifNotExists().on('tables').column('workspace_id').execute()

  // Views indexes
  await db.schema.createIndex('idx_views_table').ifNotExists().on('views').column('table_id').execute()
  await db.schema.createIndex('idx_views_type').ifNotExists().on('views').column('type').execute()
  await db.schema.createIndex('idx_views_created_by').ifNotExists().on('views').column('created_by').execute()

  // View states indexes
  await db.schema.createIndex('idx_view_states_user').ifNotExists().on('view_states').column('user_id').execute()
  await db.schema.createIndex('idx_view_states_accessed').ifNotExists().on('view_states').column('last_accessed').execute()

  // Form responses indexes
  await db.schema.createIndex('idx_form_responses_view_id').ifNotExists().on('form_responses').column('view_id').execute()
  await db.schema.createIndex('idx_form_responses_submitted_at').ifNotExists().on('form_responses').column('submitted_at').execute()

  // ============================================
  // 11. Create update_updated_at function and triggers
  // ============================================
  console.log('[Migration] Creating triggers...')

  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  // Apply triggers
  await sql`DROP TRIGGER IF EXISTS update_tables_updated_at ON tables`.execute(db)
  await sql`CREATE TRIGGER update_tables_updated_at BEFORE UPDATE ON tables FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_views_updated_at ON views`.execute(db)
  await sql`CREATE TRIGGER update_views_updated_at BEFORE UPDATE ON views FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states`.execute(db)
  await sql`CREATE TRIGGER update_view_states_updated_at BEFORE UPDATE ON view_states FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_kanban_configs_updated_at ON kanban_configs`.execute(db)
  await sql`CREATE TRIGGER update_kanban_configs_updated_at BEFORE UPDATE ON kanban_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_calendar_configs_updated_at ON calendar_configs`.execute(db)
  await sql`CREATE TRIGGER update_calendar_configs_updated_at BEFORE UPDATE ON calendar_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_gallery_configs_updated_at ON gallery_configs`.execute(db)
  await sql`CREATE TRIGGER update_gallery_configs_updated_at BEFORE UPDATE ON gallery_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_form_configs_updated_at ON form_configs`.execute(db)
  await sql`CREATE TRIGGER update_form_configs_updated_at BEFORE UPDATE ON form_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at()`.execute(db)

  console.log('[Migration] Multi-view system tables created successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  console.log('[Migration] Rolling back: dropping multi-view system tables')

  // Drop triggers
  await sql`DROP TRIGGER IF EXISTS update_form_configs_updated_at ON form_configs`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_gallery_configs_updated_at ON gallery_configs`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_calendar_configs_updated_at ON calendar_configs`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_kanban_configs_updated_at ON kanban_configs`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_views_updated_at ON views`.execute(db)
  await sql`DROP TRIGGER IF EXISTS update_tables_updated_at ON tables`.execute(db)

  // Drop tables in reverse order (respecting foreign keys)
  await db.schema.dropTable('view_permissions').ifExists().cascade().execute()
  await db.schema.dropTable('form_responses').ifExists().cascade().execute()
  await db.schema.dropTable('form_configs').ifExists().cascade().execute()
  await db.schema.dropTable('gallery_configs').ifExists().cascade().execute()
  await db.schema.dropTable('calendar_configs').ifExists().cascade().execute()
  await db.schema.dropTable('kanban_configs').ifExists().cascade().execute()
  await db.schema.dropTable('view_states').ifExists().cascade().execute()
  await db.schema.dropTable('views').ifExists().cascade().execute()
  await db.schema.dropTable('tables').ifExists().cascade().execute()

  console.log('[Migration] Rollback completed successfully')
}
