/**
 * Register the three approval-product permission codes that no migration has ever inserted into the
 * `permissions` catalogue: `approvals:write`, `approvals:act` and `approval-templates:manage`.
 *
 * This is the sibling of `zzzz20260920130000_add_approval_product_permissions`, which registered
 * `approvals:read` and explicitly left these three for a separate decision (its header, "SCOPE"). It
 * follows that file's shape and scope boundary exactly: CATALOGUE ROWS ONLY, ZERO GRANTS.
 *
 * Existence is not cosmetic. `role_permissions.permission_code` and `user_permissions.permission_code`
 * both carry a foreign key to `permissions(code)`, and both product grant entries check the catalogue
 * before they write: `POST /api/permissions/grant` (`routes/permissions.ts`) answers 400 "Permission
 * code ... does not exist", and `POST /api/roles` / `PUT /api/roles/:id` (`assertCodesInCatalog`,
 * `routes/roles.ts`) answer 400 `UNKNOWN_PERMISSION_CODE`. Access presets and permission templates
 * write the same FK-bound tables. So until this migration NO product path could give a non-admin user
 * any of these three codes, although routes already guard on them. Global admins are unaffected
 * (`rbacGuard` returns for them before the code is looked at), which is why the gap stayed invisible.
 *
 * WHAT EACH CODE IS GUARDED BY (route-level facts, for the record; none of this changes here):
 *   - `approvals:write`: `rbacGuard('approvals', 'write')` on `POST /api/approvals`,
 *     `POST /api/approvals/preview`, `GET /api/approvals/record-link-options` and the form-draft
 *     routes; the draft-attachment upload check; and `createApproval`, which re-checks it against the
 *     database inside its own transaction.
 *   - `approvals:act`: `rbacGuard('approvals', 'act')` on `POST /api/approvals/:id/actions`, the two
 *     legacy decision routes and the card-delivery routes; and the process-attachment upload check.
 *   - `approval-templates:manage`: one of the two literals in `approvalTemplateAdminGuard`
 *     (`rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`), which fronts
 *     template authoring and publishing, template groups and the admin delegation routes; the web
 *     client's `canManageTemplates` capability reads this same code.
 *
 * SCOPE: exactly these three codes. `approvals:read` (the sibling migration above) and
 * `approvals:admin` / `approvals:admin-templates` / `approvals:admin-data` /
 * `approvals:analytics` (`zzzz20260702110000_add_approval_reassign_and_admin_scopes`,
 * `zzzz20260630090000_add_approvals_analytics_permission`) are already registered and are not touched.
 *
 * NAMESPACE POSTURE: `approvals` is in `NON_NAMESPACED_PERMISSION_RESOURCES`
 * (`src/rbac/namespace-admission.ts`), so `approvals:write` and `approvals:act` carry no second gate
 * once granted. `approval-templates` is NOT in that set: `isPermissionAllowedByNamespaceAdmission`
 * still applies to `approval-templates:manage` wherever the guards above evaluate it, so registering
 * the code makes it grantable and bindable but does not by itself decide whether a given holder is
 * admitted by `approvalTemplateAdminGuard`. This migration neither changes that nor adds an
 * admission; whether that code should be exempted is a separate policy decision.
 *
 * Shape: the `permissions` insert follows `zzzz20260920130000_add_approval_product_permissions`
 * (`checkTableExists` guard + `ON CONFLICT (code) DO NOTHING`, one bound-parameter statement per
 * code, so the access-presets catalogue guard can read every inserted `code` back).
 *
 * NOTE ON DESCRIPTION TEXT AND PRE-EXISTING ROWS: the insert is `ON CONFLICT (code) DO NOTHING`, so a
 * row that already exists keeps its `name`/`description` forever and a later wording edit here does
 * not update it. A row can pre-exist because `PluginRbacProvisioningService.applyRoleMatrix`
 * (`services/PluginRbacProvisioningService.ts`) self-registers every code a plugin's role matrix names
 * ("Provisioned by <plugin>: <code>") and writes role bindings for it; no plugin in this repository
 * names any of these three codes (checked when this file was written), but a deployed plugin could.
 * Picking up this wording on such a database needs a manual `UPDATE permissions SET name = ...,
 * description = ... WHERE code = '<code>'`. The descriptions below state the route-level capability
 * and deliberately make no promise about which instances a holder may act on: that is decided per
 * request by each route, not by holding the code.
 *
 * DELIBERATELY NOT DONE BY THIS MIGRATION: no `role_permissions` insert, no `user_permissions`
 * insert, no bulk-apply, no access-preset or permission-template change (`src/auth/access-presets.ts`
 * is untouched). Unlike `zzzz20260630090000_add_approvals_analytics_permission` and
 * `zzzz20260702110000_add_approval_reassign_and_admin_scopes`, which bind their codes to `admin`,
 * nothing here is bound to anybody, so this migration is a pure catalogue-registration no-op for
 * every existing user's effective permissions until an administrator explicitly grants a code,
 * per user through `POST /api/permissions/grant` or per role (every current and future holder of the
 * role at once) through `POST /api/roles` / `PUT /api/roles/:id`. Who should hold these codes by
 * default, and through which preset or role, is an approval-product policy decision that belongs to
 * the owner and is NOT made here.
 *
 * `down()` deletes the three codes' rows from `role_permissions`, then `user_permissions`, then
 * `permissions`. Both grant tables carry an `ON DELETE CASCADE` foreign key to `permissions(code)`,
 * so the final DELETE alone would cascade them away; the two explicit DELETEs are written out so the
 * row-loss is visible at the call site (same as the sibling migration).
 *
 * DISCLOSURE: rolling this migration back is NOT reversible for grant state. It permanently drops
 * every `role_permissions` / `user_permissions` row for these three codes, whoever wrote it: an
 * administrator through the product endpoints, a preset, or a plugin through `applyRoleMatrix`
 * (rows this migration never created). Re-running `up()` re-registers the catalogue rows only; every
 * holder has to be granted again.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const APPROVAL_PRODUCT_PERMISSIONS = [
  {
    code: 'approvals:write',
    name: 'Approvals Write',
    description:
      'Start approvals: create and preview approval instances from published templates, keep form ' +
      'drafts and upload draft attachments. Does not allow acting on an approval (approvals:act) or ' +
      'authoring templates (approval-templates:manage)',
  },
  {
    code: 'approvals:act',
    name: 'Approvals Act',
    description:
      'Take decision actions on approval instances (approve, reject, return, transfer, add/reduce ' +
      'sign) through the approval action endpoints. Route-level capability: each route evaluates ' +
      'whether the holder may act on a given instance',
  },
  {
    code: 'approval-templates:manage',
    name: 'Approval Templates Manage',
    description:
      'Author and manage approval templates (create, edit, publish, archive, template groups) and ' +
      'administer approval delegations; the same template-admin guard also accepts ' +
      'approvals:admin-templates',
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
  // Deliberately no role_permissions / user_permissions insert — see file header. Default ownership
  // of these codes is an owner policy decision, not something this migration decides.
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
