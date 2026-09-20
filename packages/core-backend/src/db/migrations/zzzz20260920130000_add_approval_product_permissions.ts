/**
 * `approvals:read` / `approvals:write` / `approvals:act` — register the three approval-product
 * permission codes that `APPROVAL_PRODUCT_PERMISSIONS` (`src/types/approval-product.ts`) has always
 * declared but which no migration has ever inserted into the `permissions` catalogue.
 *
 * Existence is not cosmetic: `role_permissions.permission_code` and `user_permissions.permission_code`
 * both carry a foreign key to `permissions(code)`, and the product's own grant endpoint
 * (`routes/permissions.ts:156-164`) 400s on an unrecognized code before it ever reaches that FK. So
 * today NO product path — not `POST /api/permissions/grant`, not a role-permission seed, nothing — can
 * grant any of these three codes to a non-admin user. Global admins are unaffected: `rbacGuard`
 * (`rbac/rbac.ts:69`, and redundantly `:94-98`) resolves `requestUserIsAdmin(...)` and returns `next()`
 * before the permission code is ever looked up, so the gap has been invisible on `main` even though the
 * gate it feeds — `rbacGuard('approvals', <action>)` — already sits in front of a dozen-plus existing
 * routes: `approvals.ts` (list/get/pending/pending-count/mark-read/mark-all-read/remind/delegations for
 * `read`; the `PUT`/`preview`/`create` trio for `write`; card-delivery actions/`actions`/`approve`/
 * `reject` for `act`), `approval-history.ts:134` and `approval-comments.ts` (all five routes) for `read`.
 *
 * `approvals` is already in `NON_NAMESPACED_PERMISSION_RESOURCES`
 * (`src/rbac/namespace-admission.ts:13`), so `isPermissionAllowedByNamespaceAdmission` short-circuits to
 * `true` for all three codes (`derivePermissionNamespace` returns `null` for a non-admission-controlled
 * resource) — nothing to add there, and no second gate stands between a catalogue row and a working
 * `user_permissions` grant.
 *
 * Shape: the `permissions` insert follows `zzzz20260915121000_add_multitable_submit_approval_permission`
 * (information_schema guard + `ON CONFLICT DO NOTHING`).
 *
 * DELIBERATELY NOT DONE BY THIS MIGRATION — no `role_permissions` insert, for any role, for any of the
 * three codes. Unlike `zzzz20260630090000_add_approvals_analytics_permission` and
 * `zzzz20260702110000_add_approval_reassign_and_admin_scopes` (which bind their new codes to `admin`),
 * this migration grants NOTHING to ANYONE — it only makes the three codes grantable through the existing
 * admin-operated grant endpoint. Who should hold `approvals:read` / `approvals:write` / `approvals:act`
 * by default (all authenticated users? a specific role? nobody, opt-in only?) is an approval-product
 * policy decision that belongs to the owner, the same way
 * `zzzz20260915121000_add_multitable_submit_approval_permission` left `approvals:write` seeding out of
 * its own scope for the identical reason. Because no role binding is added, this migration is a pure
 * catalogue-registration no-op for every existing user's effective permissions — it changes nothing
 * until an admin explicitly grants one of these codes to someone through
 * `POST /api/permissions/grant`.
 *
 * `down()` removes only these three codes' rows, in FK order: `role_permissions` (defensive — this
 * migration's own `up()` writes none, but `down()` must still clear any that were added out-of-band by an
 * admin grant recorded against a role after this shipped) is not applicable here since role bindings are
 * never written by this file; the real dependents are `user_permissions` rows an admin may have granted
 * via the product path while these codes existed, which `down()` deletes before deleting the
 * `permissions` rows themselves so the FK is never violated.
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
  {
    code: 'approvals:write',
    name: 'Approvals Write',
    description: 'Create and update approval instances (submit for approval, edit, preview)',
  },
  {
    code: 'approvals:act',
    name: 'Approvals Act',
    description: 'Take approval actions on an assigned node (approve, reject, sign, and other node actions)',
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
  // Deliberately no role_permissions insert — see file header. Default ownership of these codes
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
