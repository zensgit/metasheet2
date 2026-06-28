import type { Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * RA-1b CURATED-VOCABULARY: the curated source for `requester.role in [...]` approval routing.
 *
 * `roles.approval_usable` is the SINGLE source of truth for which RBAC roles an author may route on in a
 * formula condition. Secure-by-default: `NOT NULL DEFAULT false`, so EVERY existing role (incl. admin /
 * system roles) is excluded until an administrator explicitly opts it in. The curated set is
 * `SELECT id FROM roles WHERE approval_usable = true`, enforced at publish + dry-run and used to freeze
 * only curated roles into the requester snapshot.
 *
 * Idempotent: guarded by checkTableExists + checkColumnExists so re-runs (and environments where `roles`
 * has not yet been created) are no-ops.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const rolesExists = await checkTableExists(db, 'roles')
  if (!rolesExists) return

  const hasApprovalUsable = await checkColumnExists(db, 'roles', 'approval_usable')
  if (!hasApprovalUsable) {
    await db.schema
      .alterTable('roles')
      .addColumn('approval_usable', 'boolean', (col) => col.notNull().defaultTo(false))
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rolesExists = await checkTableExists(db, 'roles')
  if (!rolesExists) return

  const hasApprovalUsable = await checkColumnExists(db, 'roles', 'approval_usable')
  if (hasApprovalUsable) {
    await db.schema
      .alterTable('roles')
      .dropColumn('approval_usable')
      .execute()
  }
}
