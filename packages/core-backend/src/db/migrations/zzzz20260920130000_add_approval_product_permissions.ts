/**
 * `approvals:read` — register this one approval-product permission code that
 * `APPROVAL_PRODUCT_PERMISSIONS` (`src/types/approval-product.ts`) has always declared but which no
 * migration has ever inserted into the `permissions` catalogue.
 *
 * Existence is not cosmetic: `role_permissions.permission_code` and `user_permissions.permission_code`
 * both carry a foreign key to `permissions(code)`, and the product's own grant endpoint
 * (`routes/permissions.ts:156-164`) 400s on an unrecognized code before it ever reaches that FK. So
 * today NO product path — not `POST /api/permissions/grant`, not a role-permission seed, nothing — can
 * grant `approvals:read` to a non-admin user. Global admins are unaffected: `rbacGuard`
 * (`rbac/rbac.ts:69`, and redundantly `:94-98`) resolves `requestUserIsAdmin(...)` and returns `next()`
 * before the permission code is ever looked up, so the gap has been invisible on `main` even though the
 * gate it feeds — `rbacGuard('approvals', 'read')` — already sits in front of a dozen-plus existing
 * routes: `approvals.ts` (list/get/pending/pending-count/mark-read/mark-all-read/remind/delegations),
 * `approval-history.ts:134`, and `approval-comments.ts` (all five routes).
 *
 * SCOPE: `approvals:write` and `approvals:act` are DELIBERATELY NOT registered here. Both are
 * declared in the same `APPROVAL_PRODUCT_PERMISSIONS` constant and share the identical catalogue
 * gap, but widening the grantable surface for them is a separate owner decision and is out of
 * scope for this migration. Nothing about either code changes: both remain exactly as ungrantable
 * after this migration as before it. A follow-up migration can register them once that decision is
 * made — this file's shape (below) is written to extend cleanly to more rows.
 *
 * `approvals` is already in `NON_NAMESPACED_PERMISSION_RESOURCES`
 * (`src/rbac/namespace-admission.ts:13`), so `isPermissionAllowedByNamespaceAdmission` short-circuits to
 * `true` for `approvals:read` (`derivePermissionNamespace` returns `null` for a non-admission-controlled
 * resource) — nothing to add there, and no second gate stands between this catalogue row and a working
 * `user_permissions` grant.
 *
 * Shape: the `permissions` insert follows `zzzz20260915121000_add_multitable_submit_approval_permission`
 * (information_schema guard + `ON CONFLICT DO NOTHING`).
 *
 * NOTE ON DESCRIPTION TEXT: the `permissions` insert is `ON CONFLICT (code) DO NOTHING`, so a
 * database that already ran an earlier candidate version of this file (e.g. a pre-merge head applied
 * to a long-lived test/staging DB) keeps that earlier `name`/`description` text forever — a later
 * wording edit to `APPROVAL_PRODUCT_PERMISSIONS` below does NOT retroactively update the stored row.
 * Picking up a wording change on such a database needs a manual `UPDATE permissions SET name = …,
 * description = … WHERE code = 'approvals:read'`. Not applicable to this PR's own one-time throwaway
 * DBs, each created fresh and dropped after use.
 *
 * DELIBERATELY NOT DONE BY THIS MIGRATION — no `role_permissions` insert for `approvals:read`. Unlike
 * `zzzz20260630090000_add_approvals_analytics_permission` and
 * `zzzz20260702110000_add_approval_reassign_and_admin_scopes` (which bind their new codes to `admin`),
 * this migration's own `up()` grants NOTHING to ANYONE — it performs no `role_permissions` or
 * `user_permissions` insert and no bulk-apply. What it DOES do is unblock the catalogue check that
 * BOTH existing admin-operated grant paths run before they will accept this code:
 * `assertCodesInCatalog` (`routes/roles.ts:381`) — called from `POST /api/roles` (`:496`) and
 * `PUT /api/roles/:id` (`:588`) before either writes `role_permissions` — and the equivalent
 * unrecognized-code check in `routes/permissions.ts:156-164` before `POST /api/permissions/grant`
 * writes `user_permissions`. So once this migration merges, an admin can grant `approvals:read`
 * EITHER per-user through `POST /api/permissions/grant`, OR per-role — in a single call, binding it
 * to every current and future holder of that role at once — through `POST /api/roles` /
 * `PUT /api/roles/:id`. Which of those two paths gets used, and who should hold `approvals:read` by
 * default (all authenticated users? a specific role? nobody, opt-in only?), is an approval-product
 * policy decision that belongs to the owner, the same way
 * `zzzz20260915121000_add_multitable_submit_approval_permission` left `approvals:write` seeding out
 * of its own scope for the identical reason. Because this migration's own `up()` adds no role
 * binding, it is a pure catalogue-registration no-op for every existing user's effective
 * permissions — it changes nothing until an admin explicitly grants it, through either product path
 * above.
 *
 * `down()` deletes the `approvals:read` row from `role_permissions`, then `user_permissions`, then
 * `permissions`, in that order. Both `role_permissions.permission_code` and
 * `user_permissions.permission_code` carry an `ON DELETE CASCADE` foreign key to `permissions(code)`
 * (`20250924190000_create_rbac_tables.ts:99-112` — verified `confdeltype='c'` on both constraints), so
 * the final `permissions` DELETE alone would already cascade both rows away; the two explicit DELETEs
 * above it are redundant-by-CASCADE, written out so the row-loss is visible at the call site rather
 * than implicit in a constraint a future reader of this file would otherwise have to go look up.
 * `role_permissions` has no row from this migration's own `up()`; any row that exists came from an
 * admin's own `POST /api/roles` / `PUT /api/roles/:id` call — the role-permission product endpoints
 * (`routes/roles.ts:496`/`:588`), the same authorized, audited path `user_permissions` rows come from
 * (`POST /api/permissions/grant`), not an out-of-band write.
 *
 * DISCLOSURE — rolling this migration back is NOT reversible for grant state: it permanently drops
 * every `role_permissions`/`user_permissions` row for `approvals:read`, whether granted per-user or
 * per-role, with no compensation path and no audit trail of what was dropped. Re-running `up()`
 * re-registers the catalogue row but does not restore who held it — an admin has to re-grant each
 * holder again, per-user through `POST /api/permissions/grant` or per-role through `POST /api/roles` /
 * `PUT /api/roles/:id`. Same shape as
 * `zzzz20260915121000_add_multitable_submit_approval_permission`'s `down()`, which has the identical
 * property for `approvals:write`.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const APPROVAL_PRODUCT_PERMISSIONS = [
  {
    code: 'approvals:read',
    name: 'Approvals Read',
    description:
      'Read approval instances, history, comments, delegations, and pending/todo queues — also gates ' +
      'a few write-shaped actions sharing this same guard (see the migration file header); not a ' +
      'pure read-only grant',
  },
] as const
const APPROVAL_PRODUCT_PERMISSION_CODES = APPROVAL_PRODUCT_PERMISSIONS.map((permission) => permission.code)

export async function up(db: Kysely<unknown>): Promise<void> {
  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    for (const permission of APPROVAL_PRODUCT_PERMISSIONS) {
      await sql`
        INSERT INTO permissions (code, name, description)
        VALUES (${permission.code}, ${permission.name}, ${permission.description})
        ON CONFLICT (code) DO NOTHING
      `.execute(db)
    }
  }
  // Deliberately no role_permissions insert — see file header. Default ownership of this code
  // is an owner policy decision, not something this migration decides.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'role_permissions')) {
    await sql`
      DELETE FROM role_permissions
      WHERE permission_code IN (${sql.join(APPROVAL_PRODUCT_PERMISSION_CODES)})
    `.execute(db)
  }

  if (await checkTableExists(db, 'user_permissions')) {
    await sql`
      DELETE FROM user_permissions
      WHERE permission_code IN (${sql.join(APPROVAL_PRODUCT_PERMISSION_CODES)})
    `.execute(db)
  }

  if (await checkTableExists(db, 'permissions')) {
    await sql`
      DELETE FROM permissions
      WHERE code IN (${sql.join(APPROVAL_PRODUCT_PERMISSION_CODES)})
    `.execute(db)
  }
}
