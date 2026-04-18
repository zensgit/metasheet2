import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_view_permissions
    DROP CONSTRAINT IF EXISTS meta_view_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE meta_view_permissions
    ADD CONSTRAINT meta_view_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role', 'member-group'))
  `.execute(db)

  await sql`
    ALTER TABLE field_permissions
    DROP CONSTRAINT IF EXISTS field_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE field_permissions
    ADD CONSTRAINT field_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role', 'member-group'))
  `.execute(db)

  await sql`
    ALTER TABLE record_permissions
    DROP CONSTRAINT IF EXISTS record_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE record_permissions
    ADD CONSTRAINT record_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role', 'member-group'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM meta_view_permissions
    WHERE subject_type = 'member-group'
  `.execute(db)
  await sql`
    ALTER TABLE meta_view_permissions
    DROP CONSTRAINT IF EXISTS meta_view_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE meta_view_permissions
    ADD CONSTRAINT meta_view_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role'))
  `.execute(db)

  await sql`
    DELETE FROM field_permissions
    WHERE subject_type = 'member-group'
  `.execute(db)
  await sql`
    ALTER TABLE field_permissions
    DROP CONSTRAINT IF EXISTS field_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE field_permissions
    ADD CONSTRAINT field_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role'))
  `.execute(db)

  await sql`
    DELETE FROM record_permissions
    WHERE subject_type = 'member-group'
  `.execute(db)
  await sql`
    ALTER TABLE record_permissions
    DROP CONSTRAINT IF EXISTS record_permissions_subject_type_check
  `.execute(db)
  await sql`
    ALTER TABLE record_permissions
    ADD CONSTRAINT record_permissions_subject_type_check
    CHECK (subject_type IN ('user', 'role'))
  `.execute(db)
}
