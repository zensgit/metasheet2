import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO permissions (code, name, description)
        VALUES
          ('attendance:read', 'Attendance Read', 'Read attendance records and summaries'),
          ('attendance:write', 'Attendance Write', 'Create attendance punches and adjustment requests'),
          ('attendance:approve', 'Attendance Approve', 'Approve or reject attendance adjustments'),
          ('attendance:admin', 'Attendance Admin', 'Manage attendance rules, settings, and schedules')
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
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO role_permissions (role_id, permission_code)
        VALUES
          ('admin', 'attendance:read'),
          ('admin', 'attendance:write'),
          ('admin', 'attendance:approve'),
          ('admin', 'attendance:admin')
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
        WHERE permission_code IN (
          'attendance:read',
          'attendance:write',
          'attendance:approve',
          'attendance:admin'
        );
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
        WHERE code IN (
          'attendance:read',
          'attendance:write',
          'attendance:approve',
          'attendance:admin'
        );
      END IF;
    END $$;
  `.execute(db)
}
