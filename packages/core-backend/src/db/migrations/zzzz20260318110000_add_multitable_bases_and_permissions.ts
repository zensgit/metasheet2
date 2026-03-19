import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const LEGACY_BASE_ID = 'base_legacy'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_bases (
      id text PRIMARY KEY,
      name text NOT NULL,
      icon text,
      color text,
      owner_id text,
      workspace_id text,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      deleted_at timestamptz
    )
  `.execute(db)

  await sql`
    ALTER TABLE meta_sheets
    ADD COLUMN IF NOT EXISTS base_id text
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_sheets_base
    ON meta_sheets(base_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_bases_workspace
    ON meta_bases(workspace_id)
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'meta_sheets_base_id_fkey'
      ) THEN
        ALTER TABLE meta_sheets
        ADD CONSTRAINT meta_sheets_base_id_fkey
        FOREIGN KEY (base_id) REFERENCES meta_bases(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
    VALUES (${LEGACY_BASE_ID}, 'Migrated Base', 'table', '#1677ff', NULL, NULL)
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    UPDATE meta_sheets
    SET base_id = ${LEGACY_BASE_ID}
    WHERE base_id IS NULL
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO permissions (code, name, description)
        VALUES
          ('multitable:read', 'Multitable Read', 'Read multitable bases, sheets, views, and records'),
          ('multitable:write', 'Multitable Write', 'Manage multitable bases, fields, views, and records')
        ON CONFLICT (code) DO NOTHING;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'role_permissions'
      ) THEN
        INSERT INTO role_permissions (role_id, permission_code)
        VALUES
          ('admin', 'multitable:read'),
          ('admin', 'multitable:write')
        ON CONFLICT DO NOTHING;
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'role_permissions'
      ) THEN
        DELETE FROM role_permissions
        WHERE permission_code IN ('multitable:read', 'multitable:write');
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        DELETE FROM permissions
        WHERE code IN ('multitable:read', 'multitable:write');
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE meta_sheets
    DROP CONSTRAINT IF EXISTS meta_sheets_base_id_fkey
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_meta_sheets_base
  `.execute(db)

  await sql`
    ALTER TABLE meta_sheets
    DROP COLUMN IF EXISTS base_id
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_meta_bases_workspace
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS meta_bases
  `.execute(db)
}
