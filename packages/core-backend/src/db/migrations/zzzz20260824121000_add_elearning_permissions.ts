import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning V0.1 permission seed (design-lock §5.1).
 *
 * Codes: elearning:read|write|grade|stats|admin.
 * Shape copied from zzzz20260117090000 (DO $$ + ON CONFLICT).
 * elearning:admin is global, matching attendance:admin — it is not a
 * departmental scope. Role templates are out of this slice.
 *
 * down() removes only this domain's permission rows.
 */

export const ELEARNING_PERMISSION_CODES = [
  'elearning:read',
  'elearning:write',
  'elearning:grade',
  'elearning:stats',
  'elearning:admin',
] as const

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
          ('elearning:read', 'E-learning Read', 'Read published learning content and own attempts'),
          ('elearning:write', 'E-learning Write', 'Create and edit learning content and exams'),
          ('elearning:grade', 'E-learning Grade', 'Grade exam attempts within authorized scope'),
          ('elearning:stats', 'E-learning Stats', 'Read learning statistics'),
          ('elearning:admin', 'E-learning Admin', 'Global e-learning administration')
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
          ('admin', 'elearning:read'),
          ('admin', 'elearning:write'),
          ('admin', 'elearning:grade'),
          ('admin', 'elearning:stats'),
          ('admin', 'elearning:admin')
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
          'elearning:read',
          'elearning:write',
          'elearning:grade',
          'elearning:stats',
          'elearning:admin'
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
          'elearning:read',
          'elearning:write',
          'elearning:grade',
          'elearning:stats',
          'elearning:admin'
        );
      END IF;
    END $$;
  `.execute(db)
}
