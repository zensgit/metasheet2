import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * G02 PR-1 — the three data-source verbs the sharing model needs, seeded as rows and granted to
 * nobody.
 *
 * Codes:
 *   data_sources:use | data_sources:rotate | data_sources:share
 *
 * WHY THREE NEW CODES INSTEAD OF REUSING THE EXISTING THREE
 *
 * `data_sources:read` / `:write` / `:execute` are the whole vocabulary today, and each of them is
 * too coarse for a sharing model in a different direction:
 *
 *   - `read` LEAKS CONNECTION COORDINATES. `sanitizeConfig` (src/routes/data-sources.ts:321-327)
 *     strips `credentials` and nothing else, so `connection` — host / port / database — rides back
 *     out on `GET /api/data-sources/:id` (:437). `GET /:id/test` (:989, also a `read` gate) returns
 *     the redacted driver text, and `BaseAdapter.redactSecrets` redacts VALUES of
 *     password/token/apiKey/secret, not host/port/database/username. "Let a colleague USE this
 *     connection" must therefore not be spelled `read`, or sharing would hand out the customer's
 *     database coordinates as a side effect. Hence `use`, which will (in a LATER pr) gate only the
 *     three surfaces that carry no `connection` in their responses: `/:id/schema`,
 *     `/:id/tables/:table`, `/:id/select`.
 *
 *   - `write` CONFLATES ROTATING A PASSWORD WITH REPOINTING THE SOURCE. `PUT /:id/credentials`
 *     (:716) and `PUT /:id` (:615) share one code today, so the only way to let an operator do the
 *     high-frequency, low-blast-radius thing (swap a password; the target database does not move)
 *     is to also let them do the high-blast-radius thing (change `connection.host`, which moves
 *     where every pipeline built on this source reads from — `assertSqlSourceProvisionableAtRuntime`
 *     only pins ARMED ids, so an unarmed source has no runtime pin stopping a repoint). Hence
 *     `rotate`, and THIS migration's companion change makes :716 require it EXCLUSIVELY.
 *
 *   - neither expresses "hand this source to my tenant". Folding that into `write` would mean every
 *     person who can edit a connection string can also silently widen who reaches it, burying an
 *     auditable authorization act inside routine configuration editing. Hence `share`, reserved for
 *     the `PUT /:id/scope` route a later PR adds. It is seeded here so the vocabulary lands in one
 *     migration rather than three.
 *
 * SAME `data_sources` PREFIX, ON PURPOSE. `derivePermissionResource`
 * (src/rbac/namespace-admission.ts:125-131) takes everything before the FIRST colon, so all three
 * codes derive the resource `data_sources` and therefore ride the SAME namespace-admission switch
 * the existing three ride. Operators enable one namespace, not four. A `data_sources_share:*`-style
 * new prefix would have created a second admission surface for no security gain.
 *
 * Shape copied from zzzz20260830100000_add_stock_prep_permissions (DO $$ table guard + ON CONFLICT
 * (code) DO NOTHING), including its one deliberate omission: NO `role_permissions` insert.
 *
 * ZERO AUTOMATIC HOLDERS — and here that omission has a cost this migration accepts on purpose.
 * Seeding makes the codes EXIST (without a `permissions` row the grant is refused by the database
 * itself: `role_permissions.permission_code` / `user_permissions.permission_code` are FOREIGN KEYs
 * onto `permissions(code)`, 20250924190000_create_rbac_tables.ts:92-115). It grants them to nobody,
 * not to a user and not to the `admin` role. Platform admins lose nothing — `rbacGuard`
 * short-circuits on the global-admin tier before consulting any table (src/rbac/rbac.ts:69-72) — but
 * a NON-ADMIN who holds `data_sources:write` today and nothing else WILL LOSE credential rotation
 * the moment :716 becomes rotate-exclusive, until an administrator grants them `data_sources:rotate`
 * THROUGH A ROLE. That is fail-closed by design, and the deployment prerequisite is written down
 * rather than automated:
 *
 *     -- read-only, run BEFORE deploying this migration's companion gate change
 *     SELECT 'role_permissions' AS surface, role_id AS subject, COUNT(*) AS grants
 *       FROM role_permissions WHERE permission_code = 'data_sources:write' GROUP BY role_id
 *     UNION ALL
 *     SELECT 'user_permissions', user_id::text, COUNT(*)
 *       FROM user_permissions WHERE permission_code = 'data_sources:write' GROUP BY user_id;
 *
 * If that returns any row, grant `data_sources:rotate` to those subjects VIA A ROLE first (a direct
 * `user_permissions` grant is filtered out by namespace admission and presents as a 403 — the
 * 2026-09-08 stock-prep lesson), then ship the exclusive gate. This migration deliberately does NOT
 * write `role_permissions` to "fix" that automatically: a migration that grants is a grant made by
 * nobody, which is exactly the 零自动 posture the stock-prep decision (R-11) fixed.
 *
 * NOT ADDED TO `NON_NAMESPACED_PERMISSION_RESOURCES` (src/rbac/namespace-admission.ts:11-38). That
 * set is an EXEMPTION list — `isNamespaceAdmissionControlledResource` answers true for everything
 * NOT in it — so putting `data_sources` there would not "make grants work", it would make every
 * existing and future holder of every `data_sources:*` code bypass `user_namespace_admissions`
 * entirely. That is a widening on the namespace that reaches customer database credentials, and it
 * is not this migration's job.
 *
 * down() removes only these three codes, children before parents (FK order). The FK is
 * ON DELETE CASCADE, so deleting the `permissions` rows alone would already drop the grants; the
 * explicit child deletes exist so the blast radius is visible in the source.
 */

/** The three verbs G02 introduces. Ordered as inserted. */
export const DATA_SOURCE_SHARING_PERMISSION_CODES = [
  'data_sources:use',
  'data_sources:rotate',
  'data_sources:share',
] as const

/**
 * The `data_sources:*` codes that existed before G02 — enforced in `src/routes/data-sources.ts`
 * since long before this migration and seeded by G09's
 * `zzzz20260910120000_add_integration_permissions` (in flight as #5611 at the time of writing).
 * Listed here, not imported, precisely because this migration must not depend on that one having
 * landed: the two are independent and may merge in either order.
 */
export const DATA_SOURCE_PREEXISTING_PERMISSION_CODES = [
  'data_sources:read',
  'data_sources:write',
  'data_sources:execute',
] as const

/** Every `data_sources:*` code that exists after both seeds have run. */
export const DATA_SOURCE_ALL_PERMISSION_CODES = [
  ...DATA_SOURCE_PREEXISTING_PERMISSION_CODES,
  ...DATA_SOURCE_SHARING_PERMISSION_CODES,
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
          ('data_sources:use', 'Data Sources Use', 'Select a shared data source and browse its tables, columns and sample rows — never its connection coordinates or credentials'),
          ('data_sources:rotate', 'Data Sources Rotate Credentials', 'Rotate the write-only credentials of a data source without being able to change where it points'),
          ('data_sources:share', 'Data Sources Share', 'Change the scope of a data source so other members of the same tenant may use it')
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
          'data_sources:use',
          'data_sources:rotate',
          'data_sources:share'
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
          'data_sources:use',
          'data_sources:rotate',
          'data_sources:share'
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
          'data_sources:use',
          'data_sources:rotate',
          'data_sources:share'
        );
      END IF;
    END $$;
  `.execute(db)
}
