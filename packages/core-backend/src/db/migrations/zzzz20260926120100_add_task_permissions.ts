/**
 * Seed tasks:read / tasks:write / tasks:admin. No role_permissions rows.
 * §13-10: do not seed a tasks_user role and do not exempt the namespace.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export const TASK_PERMISSION_CODES = ['tasks:read', 'tasks:write', 'tasks:admin'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO permissions (code, name, description)
        VALUES
          ('tasks:read', 'Tasks Read', 'Read tasks in the caller org'),
          ('tasks:write', 'Tasks Write', 'Create and update tasks in the caller org'),
          ('tasks:admin', 'Tasks Admin', 'Administer task settings in the caller org')
        ON CONFLICT (code) DO NOTHING;
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'role_permissions'
      ) THEN
        DELETE FROM role_permissions WHERE permission_code IN ('tasks:read', 'tasks:write', 'tasks:admin');
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_permissions'
      ) THEN
        DELETE FROM user_permissions WHERE permission_code IN ('tasks:read', 'tasks:write', 'tasks:admin');
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        DELETE FROM permissions WHERE code IN ('tasks:read', 'tasks:write', 'tasks:admin');
      END IF;
    END $$;
  `.execute(db)
}
