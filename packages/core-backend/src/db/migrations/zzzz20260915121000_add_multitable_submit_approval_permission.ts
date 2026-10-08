/**
 * `multitable:submit-approval` — record-level submit-for-approval, separated from record writing.
 *
 * Vocabulary and semantics live in `src/multitable/submit-approval-permission.ts`; this migration only
 * makes the code EXIST as a row and binds it to the `admin` role. Existence is not cosmetic:
 * `role_permissions.permission_code` and `user_permissions.permission_code` both carry a foreign key to
 * `permissions(code)`, so without this row an administrator physically cannot grant the capability — it
 * would be enforceable at the gate and ungrantable in the database.
 *
 * Shape: the `permissions` insert follows zzzz20260830160000_add_multitable_manage_schema_permission
 * (information_schema guard + ON CONFLICT DO NOTHING); the role binding follows
 * zzzz20260406113000_add_multitable_share_permission (`INSERT … SELECT FROM permissions`, so the FK to
 * `permissions(code)` cannot be violated), with ONE deliberate difference from the share migration: only
 * `admin` is bound, never `user` (design §4.2 / §9 item 1 default — the customer grants it per job role).
 * `roles(id)` is checked too, because `role_permissions.role_id` REFERENCES `roles(id)`.
 *
 * NOTE (deliberately NOT closed by this migration): a submitter ALSO needs `approvals:write`, because
 * `ApprovalProductService.createApproval` re-checks it against the DATABASE inside its own transaction.
 * Seeding `approvals:write` to a role is an approval-product decision and stays out of this migration.
 *
 * `multitable` is already in NON_NAMESPACED_PERMISSION_RESOURCES (`src/rbac/namespace-admission.ts`), so
 * this code inherits the namespace posture of its siblings — nothing to add there.
 *
 * down() removes only this code's rows, bindings first (FK order).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export const MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE = 'multitable:submit-approval'

/** ONLY `admin` is seeded. Every other holder is an explicit operational grant (design §9 item 1). */
const ROLE_PERMISSION_PAIRS = [['admin', MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE]] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  const permissionsExists = await checkTableExists(db, 'permissions')
  if (permissionsExists) {
    await sql`
      INSERT INTO permissions (code, name, description)
      VALUES (
        ${MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE},
        'Multitable Submit Approval',
        'Submit a multitable record to an approval template (record-level send-for-approval) — NOT implied by multitable:write; the approval product still requires approvals:write'
      )
      ON CONFLICT (code) DO NOTHING
    `.execute(db)
  }

  const rolePermissionsExists = await checkTableExists(db, 'role_permissions')
  const rolesExists = await checkTableExists(db, 'roles')
  if (permissionsExists && rolePermissionsExists && rolesExists) {
    for (const [roleId, permissionCode] of ROLE_PERMISSION_PAIRS) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_code)
        SELECT r.id, p.code
        FROM roles r
        CROSS JOIN permissions p
        WHERE r.id = ${roleId} AND p.code = ${permissionCode}
        ON CONFLICT DO NOTHING
      `.execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'role_permissions')) {
    await sql`
      DELETE FROM role_permissions
      WHERE permission_code = ${MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE}
    `.execute(db)
  }

  if (await checkTableExists(db, 'user_permissions')) {
    await sql`
      DELETE FROM user_permissions
      WHERE permission_code = ${MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE}
    `.execute(db)
  }

  if (await checkTableExists(db, 'permissions')) {
    await sql`
      DELETE FROM permissions
      WHERE code = ${MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE}
    `.execute(db)
  }
}
