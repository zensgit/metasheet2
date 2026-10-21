import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * O2 / R-11 — stock-preparation confirmation-queue workbench permission seed.
 *
 * Codes: stock-prep:read | stock-prep:operate | stock-prep:admin.
 * Vocabulary and semantics live in
 * `plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs`; this migration only
 * makes them EXIST as rows. That is not cosmetic: `role_permissions.permission_code` and
 * `user_permissions.permission_code` both carry a foreign key to `permissions(code)`, so without
 * these rows an administrator physically cannot grant the operator role — the codes would be
 * enforceable at the gate and ungrantable in the database.
 *
 * Shape copied from zzzz20260824121000_add_elearning_permissions (DO $$ + ON CONFLICT), with ONE
 * deliberate omission: no `role_permissions` insert.
 *
 * R-11 requires the mapping to be 零自动 — zero-automatic: the new scopes start with ZERO holders
 * and are granted per role, explicitly, as an operational act. Seeding a role binding here would be
 * exactly the automatic mapping the decision rejects. Platform admin loses nothing by the omission:
 * the plugin gate short-circuits on `role:admin` / `integration:admin` before it ever consults these
 * codes, so today's admin keeps every capability without holding any of them.
 *
 * `stock-prep` is deliberately NOT added to NON_NAMESPACED_PERMISSION_RESOURCES
 * (`src/rbac/namespace-admission.ts`). Staying admission-controlled means a granted code is still
 * filtered out until the user has an enabled `user_namespace_admissions` row — a second explicit
 * act, which is the fail-closed direction and matches R-11's "按角色显式授予".
 *
 * down() removes only this domain's rows, role bindings first (FK order).
 */

export const STOCK_PREP_PERMISSION_CODES = [
  'stock-prep:read',
  'stock-prep:operate',
  'stock-prep:admin',
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
          ('stock-prep:read', 'Stock Prep Read', 'Read the values-free stock-preparation confirmation queue'),
          ('stock-prep:operate', 'Stock Prep Operate', 'Confirm stock-preparation queue decisions and read back own value entry'),
          ('stock-prep:admin', 'Stock Prep Admin', 'Workbench-scoped stock-preparation administration (no provisioning, no pack install)')
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
        WHERE permission_code IN (
          'stock-prep:read',
          'stock-prep:operate',
          'stock-prep:admin'
        );
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
        WHERE permission_code IN (
          'stock-prep:read',
          'stock-prep:operate',
          'stock-prep:admin'
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
          'stock-prep:read',
          'stock-prep:operate',
          'stock-prep:admin'
        );
      END IF;
    END $$;
  `.execute(db)
}
