import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await db.schema
    .createTable('system_configs')
    .ifNotExists()
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'varchar(255)', col => col.notNull().unique())
    .addColumn('value', 'text', col => col.notNull())
    .addColumn('is_encrypted', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('idx_system_configs_key')
    .ifNotExists()
    .on('system_configs')
    .column('key')
    .execute()

  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS update_system_configs_updated_at ON system_configs`.execute(db)
  await sql`
    CREATE TRIGGER update_system_configs_updated_at
    BEFORE UPDATE ON system_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS update_system_configs_updated_at ON system_configs`.execute(db)
  await db.schema.dropTable('system_configs').ifExists().execute()
}
