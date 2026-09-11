import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * G09 — RBAC seed for the two permission namespaces the integration main journey already ENFORCES
 * but nobody could ever GRANT.
 *
 * Codes:
 *   integration:read | integration:write | integration:admin
 *   data_sources:read | data_sources:write | data_sources:execute
 *
 * WHY THIS EXISTS
 *
 * Both namespaces have been enforced for a long time and seeded never:
 *   - `data_sources:*` is the gate on every route in `src/routes/data-sources.ts`
 *     (`rbacGuard('data_sources', 'read' | 'write' | 'execute')`, 15 call sites at :336-:1257).
 *   - `integration:*` is the gate in `plugins/plugin-integration-core/lib/http-routes.cjs`
 *     (`hasPermission` at :896-:912 — `integration:admin` short-circuits, `read` accepts read|write,
 *     every other action requires `integration:write`).
 *
 * Neither set has a row in `permissions`. That is not cosmetic, because
 * `role_permissions.permission_code` and `user_permissions.permission_code` both carry a FOREIGN KEY
 * to `permissions(code)` (20250924190000_create_rbac_tables.ts:92-115). With no row, the grant is not
 * merely undocumented — it is physically rejected by the database. So the codes were simultaneously
 * enforceable at the gate and ungrantable in the schema, and the only way a non-admin ever reached
 * the journey was an operator hand-writing INSERTs into `permissions` on a production box.
 *
 * Shape copied from zzzz20260830100000_add_stock_prep_permissions (DO $$ + ON CONFLICT), including
 * its ONE deliberate omission: NO `role_permissions` insert.
 *
 * ZERO AUTOMATIC HOLDERS. This migration makes the six codes EXIST. It grants them to nobody — not
 * to a user, not to the `admin` role. Two reasons, and the second is the load-bearing one:
 *   1. Platform admin loses nothing by the omission. `rbacGuard` short-circuits on `role:admin`
 *      before it ever consults the tables (src/rbac/rbac.ts:69-72, :94-98), and the plugin gate
 *      short-circuits on `role:admin`/`integration:admin` the same way. Seeding ('admin', …) rows
 *      would change no answer for any caller.
 *   2. A seeded role binding is a grant made by a migration rather than by a human, which is exactly
 *      the automatic mapping the stock-prep decision (R-11 映射零自动) rejected. Every holder of
 *      these codes must be the result of an explicit operational act.
 *   (zzzz20260824121000_add_elearning_permissions DOES seed ('admin', …) rows. That is the older of
 *   the two in-repo shapes; the stock-prep shape is the newer and stricter one, and it is the one a
 *   cross-tenant-reachable namespace like `data_sources` should follow.)
 *
 * NOT ADDED TO THE NON-NAMESPACED ALLOW-LIST — READ THIS BEFORE "FIXING" A 403.
 *
 * `NON_NAMESPACED_PERMISSION_RESOURCES` in src/rbac/namespace-admission.ts:11-38 is an EXEMPTION
 * list, not an allow-list: `isNamespaceAdmissionControlledResource` returns true for everything NOT
 * in it (:133-137), and only admission-CONTROLLED codes are subject to
 * `filterPermissionCodesByNamespaceAdmission` (:356-377), which drops a code unless the user's roles
 * imply the namespace AND an enabled `user_namespace_admissions` row exists.
 *
 * So adding `integration` / `data_sources` to that set would not "make grants work" — it would make
 * EVERY existing and future holder of these codes bypass admission entirely, including holders who
 * have no admission row today. That is a widening of reachability on the two namespaces that reach
 * customer database credentials and raw query execution, and it is emphatically not this migration's
 * job. Both namespaces therefore stay admission-controlled: a granted code is still filtered out
 * until an administrator enables the namespace, which is the fail-closed direction.
 * Operators enable it per user, per namespace — see the role templates in
 * docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md §5-6.
 * (Concretely: adding either resource to that set would also make
 * `PATCH /api/admin/users/:id/namespaces/:namespace/admission` start answering 400
 * NAMESPACE_NOT_SUPPORTED for it — routes/admin-users.ts:4325-4327 only accepts admission-controlled
 * namespaces — so the "shortcut" would remove the operator's own control surface.)
 *
 * down() removes only these six codes, children first (FK order). Note that the FK is
 * ON DELETE CASCADE, so deleting the `permissions` rows alone would already remove the grants; the
 * explicit child deletes just make the blast radius visible in the source instead of implicit.
 */

/** The legacy integration tier, enforced by the plugin gate in lib/http-routes.cjs. */
export const INTEGRATION_PERMISSION_CODES = [
  'integration:read',
  'integration:write',
  'integration:admin',
] as const

/** The core data-source tier, enforced by `rbacGuard` in src/routes/data-sources.ts. */
export const DATA_SOURCES_PERMISSION_CODES = [
  'data_sources:read',
  'data_sources:write',
  'data_sources:execute',
] as const

/** Everything this migration seeds, in insert order. */
export const INTEGRATION_SEED_PERMISSION_CODES = [
  ...INTEGRATION_PERMISSION_CODES,
  ...DATA_SOURCES_PERMISSION_CODES,
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
          ('integration:read', 'Integration Read', 'Read integration workbench resources: external systems, sync runs and values-free projections'),
          ('integration:write', 'Integration Write', 'Create and modify integration configuration and run integration operations'),
          ('integration:admin', 'Integration Admin', 'Integration administration: source binding, target provisioning and pack install'),
          ('data_sources:read', 'Data Sources Read', 'Read data-source definitions, health, connection tests, schema and table metadata'),
          ('data_sources:write', 'Data Sources Write', 'Create, update and delete data sources, rotate their credentials and connect/disconnect them'),
          ('data_sources:execute', 'Data Sources Execute', 'Execute raw queries against a data source')
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
          'integration:read',
          'integration:write',
          'integration:admin',
          'data_sources:read',
          'data_sources:write',
          'data_sources:execute'
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
          'integration:read',
          'integration:write',
          'integration:admin',
          'data_sources:read',
          'data_sources:write',
          'data_sources:execute'
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
          'integration:read',
          'integration:write',
          'integration:admin',
          'data_sources:read',
          'data_sources:write',
          'data_sources:execute'
        );
      END IF;
    END $$;
  `.execute(db)
}
