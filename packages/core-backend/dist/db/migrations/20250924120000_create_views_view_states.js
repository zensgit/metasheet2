/**
 * Migration: Create views and view_states tables
 * Timestamp: 2025-09-24 12:00:00
 */
import { sql } from 'kysely';
export async function up(db) {
    // Ensure pgcrypto extension for gen_random_uuid() (idempotent)
    await sql `CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
    // Create views table (idempotent)
    await db.schema
        .createTable('views')
        .ifNotExists()
        .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql `gen_random_uuid()`))
        .addColumn('table_id', 'uuid')
        .addColumn('type', 'text', (col) => col.notNull().check(sql `type IN ('grid','kanban','gantt','form','calendar')`))
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql `'{}'::jsonb`))
        .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql `NOW()`))
        .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql `NOW()`))
        .execute();
    // Create indexes for views (idempotent)
    await db.schema
        .createIndex('idx_views_type')
        .ifNotExists()
        .on('views')
        .column('type')
        .execute();
    await sql `CREATE INDEX IF NOT EXISTS idx_views_config_gin ON views USING gin(config)`.execute(db);
    // Create view_states table (idempotent)
    await db.schema
        .createTable('view_states')
        .ifNotExists()
        .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql `gen_random_uuid()`))
        .addColumn('view_id', 'uuid', (col) => col.notNull().references('views.id').onDelete('cascade'))
        .addColumn('user_id', 'uuid', (col) => col.notNull())
        .addColumn('state', 'jsonb', (col) => col.notNull().defaultTo(sql `'{}'::jsonb`))
        .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql `NOW()`))
        .execute();
    // Create unique constraint for view_id + user_id (idempotent)
    await db.schema
        .createIndex('idx_view_states_unique')
        .ifNotExists()
        .on('view_states')
        .columns(['view_id', 'user_id'])
        .unique()
        .execute();
    // Create composite index for lookups (idempotent)
    await db.schema
        .createIndex('idx_view_states_lookup')
        .ifNotExists()
        .on('view_states')
        .columns(['view_id', 'user_id'])
        .execute();
    // Create GIN index for state column only if state column exists (may not exist if table was created by 043)
    await sql `
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'state'
      ) THEN
        BEGIN
          CREATE INDEX IF NOT EXISTS idx_view_states_gin ON view_states USING gin(state);
        EXCEPTION WHEN duplicate_object THEN NULL; END;
      END IF;
    END $$;
  `.execute(db);
    // Create trigger to auto-update updated_at timestamp
    await sql `
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db);
    // Ensure triggers are recreated idempotently
    await sql `DROP TRIGGER IF EXISTS update_views_updated_at ON views`.execute(db);
    await sql `DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states`.execute(db);
    await sql `CREATE TRIGGER update_views_updated_at BEFORE UPDATE ON views
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`.execute(db);
    await sql `CREATE TRIGGER update_view_states_updated_at BEFORE UPDATE ON view_states
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`.execute(db);
}
export async function down(db) {
    // Drop triggers
    await sql `DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states`.execute(db);
    await sql `DROP TRIGGER IF EXISTS update_views_updated_at ON views`.execute(db);
    await sql `DROP FUNCTION IF EXISTS update_updated_at_column()`.execute(db);
    // Drop tables (cascade will handle foreign keys and indexes)
    await db.schema.dropTable('view_states').ifExists().cascade().execute();
    await db.schema.dropTable('views').ifExists().cascade().execute();
}
//# sourceMappingURL=20250924120000_create_views_view_states.js.map