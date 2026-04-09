import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const templatesExists = await checkTableExists(db, 'delegated_role_scope_templates')
  if (!templatesExists) {
    await db.schema
      .createTable('delegated_role_scope_templates')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('updated_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_role_scope_templates_name
    ON delegated_role_scope_templates(name)
  `.execute(db)

  const templateDepartmentsExists = await checkTableExists(db, 'delegated_role_scope_template_departments')
  if (!templateDepartmentsExists) {
    await db.schema
      .createTable('delegated_role_scope_template_departments')
      .ifNotExists()
      .addColumn('template_id', 'uuid', (col) => col.notNull().references('delegated_role_scope_templates.id').onDelete('cascade'))
      .addColumn('directory_department_id', 'uuid', (col) => col.notNull().references('directory_departments.id').onDelete('cascade'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delegated_role_scope_template_departments_pkey'
          AND conrelid = 'delegated_role_scope_template_departments'::regclass
      ) THEN
        ALTER TABLE delegated_role_scope_template_departments
        ADD PRIMARY KEY (template_id, directory_department_id);
      END IF;
    END $$;
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_delegated_role_scope_template_departments_department',
    'delegated_role_scope_template_departments',
    'directory_department_id',
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('delegated_role_scope_template_departments').ifExists().cascade().execute()
  await db.schema.dropTable('delegated_role_scope_templates').ifExists().cascade().execute()
}
