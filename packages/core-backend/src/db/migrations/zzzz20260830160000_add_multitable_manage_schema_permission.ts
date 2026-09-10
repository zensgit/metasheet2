import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * `multitable:manage-schema` — schema management, separated from record writing.
 *
 * Vocabulary and semantics live in `src/multitable/manage-schema-permission.ts`; this migration only
 * makes the code EXIST as a row. That is not cosmetic: `role_permissions.permission_code` and
 * `user_permissions.permission_code` both carry a foreign key to `permissions(code)`, so without this
 * row an administrator physically cannot grant the capability — it would be enforceable at the gate
 * and ungrantable in the database.
 *
 * Shape copied from zzzz20260830100000_add_stock_prep_permissions (DO $$ + ON CONFLICT), including its
 * ONE deliberate omission: NO `role_permissions` insert.
 *
 * ZERO automatic holders. The predecessor code's own seed
 * (zzzz20260406113000_add_multitable_share_permission) bound `multitable:share` to the `admin` AND
 * `user` roles; doing that here would hand schema management straight back to every ordinary user and
 * undo the fix on the first migrate. Platform admin loses nothing by the omission: `deriveCapabilities`
 * short-circuits on `isAdminRole` before it ever consults this code, so today's admin keeps every
 * capability without holding it. Every other holder is an explicit, operational grant.
 *
 * `multitable` is already in NON_NAMESPACED_PERMISSION_RESOURCES (`src/rbac/namespace-admission.ts`),
 * so this code inherits the namespace posture of its siblings — nothing to add there.
 *
 * down() removes only this code's rows, bindings first (FK order).
 */

export const MULTITABLE_MANAGE_SCHEMA_PERMISSION_CODE = 'multitable:manage-schema'

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
          ('multitable:manage-schema', 'Multitable Manage Schema', 'Create, rename, retype and delete multitable fields (table structure) — NOT implied by multitable:write')
        ON CONFLICT (code) DO NOTHING;
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
        WHERE permission_code = 'multitable:manage-schema';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_permissions'
      ) THEN
        DELETE FROM user_permissions
        WHERE permission_code = 'multitable:manage-schema';
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
        WHERE code = 'multitable:manage-schema';
      END IF;
    END $$;
  `.execute(db)
}
