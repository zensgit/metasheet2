import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE spreadsheet_permissions
    ADD COLUMN IF NOT EXISTS subject_type text
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ADD COLUMN IF NOT EXISTS subject_id text
  `.execute(db)

  await sql`
    UPDATE spreadsheet_permissions
    SET subject_type = 'user'
    WHERE subject_type IS NULL OR subject_type = ''
  `.execute(db)

  await sql`
    UPDATE spreadsheet_permissions
    SET subject_id = COALESCE(subject_id, user_id)
    WHERE subject_id IS NULL OR subject_id = ''
  `.execute(db)

  await sql`
    UPDATE spreadsheet_permissions
    SET user_id = CASE WHEN subject_type = 'user' THEN subject_id ELSE NULL END
    WHERE user_id IS DISTINCT FROM CASE WHEN subject_type = 'user' THEN subject_id ELSE NULL END
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ALTER COLUMN user_id DROP NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ALTER COLUMN subject_type SET NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ALTER COLUMN subject_id SET NOT NULL
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'spreadsheet_permissions_pkey'
          AND conrelid = 'spreadsheet_permissions'::regclass
      ) THEN
        ALTER TABLE spreadsheet_permissions DROP CONSTRAINT spreadsheet_permissions_pkey;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ADD CONSTRAINT spreadsheet_permissions_pkey
    PRIMARY KEY (sheet_id, subject_type, subject_id, perm_code)
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_subject`.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_permissions_user
    ON spreadsheet_permissions(user_id, sheet_id)
    WHERE user_id IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_permissions_subject
    ON spreadsheet_permissions(subject_type, subject_id, sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM spreadsheet_permissions
    WHERE subject_type <> 'user'
  `.execute(db)

  await sql`
    UPDATE spreadsheet_permissions
    SET user_id = COALESCE(user_id, subject_id)
    WHERE subject_type = 'user'
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_subject`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_user`.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'spreadsheet_permissions_pkey'
          AND conrelid = 'spreadsheet_permissions'::regclass
      ) THEN
        ALTER TABLE spreadsheet_permissions DROP CONSTRAINT spreadsheet_permissions_pkey;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ADD CONSTRAINT spreadsheet_permissions_pkey
    PRIMARY KEY (sheet_id, user_id, perm_code)
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    ALTER COLUMN user_id SET NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    DROP COLUMN IF EXISTS subject_id
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheet_permissions
    DROP COLUMN IF EXISTS subject_type
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_permissions_user
    ON spreadsheet_permissions(user_id, sheet_id)
  `.execute(db)
}
