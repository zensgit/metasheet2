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
 * DELIBERATELY NOT DONE BY THIS MIGRATION — no `role_permissions` insert for `approvals:read`. Unlike
 * `zzzz20260630090000_add_approvals_analytics_permission` and
 * `zzzz20260702110000_add_approval_reassign_and_admin_scopes` (which bind their new codes to `admin`),
 * this migration grants NOTHING to ANYONE — it only makes `approvals:read` grantable through the
 * existing admin-operated grant endpoint. Who should hold `approvals:read` by default (all authenticated
 * users? a specific role? nobody, opt-in only?) is an approval-product policy decision that belongs to
 * the owner, the same way `zzzz20260915121000_add_multitable_submit_approval_permission` left
 * `approvals:write` seeding out of its own scope for the identical reason. Because no role binding is
 * added, this migration is a pure catalogue-registration no-op for every existing user's effective
 * permissions — it changes nothing until an admin explicitly grants `approvals:read` to someone through
 * `POST /api/permissions/grant`.
 *
 * `down()` removes only the `approvals:read` row, in FK order: `role_permissions` first (defensive —
 * this migration's own `up()` writes none, but an admin could have inserted a role_permissions row
 * referencing this code out-of-band after it shipped, and `down()` must still clear that so the later
 * `permissions` DELETE never violates the FK), then `user_permissions` (rows an admin may have granted
 * via the product path while this code existed), then the `permissions` row itself.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const APPROVAL_PRODUCT_PERMISSIONS = [
  {
    code: 'approvals:read',
    name: 'Approvals Read',
    description: 'Read approval instances, history, comments, delegations, and pending/todo queues',
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
