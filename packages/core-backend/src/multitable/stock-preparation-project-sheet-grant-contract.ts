/**
 * 一个项目一张备料表 — G1, THE CONTRACT HALF (ADR adr-stock-prep-project-sheets-20261008 §2 / addendum
 * A.6; register R-35). Pure constants and predicates shared by the plugin-scope wrapper (which
 * REFUSES) and the grant service (which WRITES), so the two can never disagree about what a
 * project sheet is or which permission level the port may hand out. No imports: this file must be
 * requirable from both sides without a load cycle.
 *
 * WHAT THE PORT IS. The plugin's provisioning surface had no authorization verb at all, so a 拉取
 * 人员 could create a project's sheet and a floor operator — who has no global `multitable:read`
 * and reads a sheet only through a grant row on it — got 403 on landing. This port lets the plugin
 * grant the SERVER-CONFIGURED roles `spreadsheet:write` on a sheet IT OWNS, and nothing else:
 *
 *   * role subjects ONLY — never a user, never a member group;
 *   * every role id inside the `stock-prep` role namespace (`stock-prep` or `stock-prep_…`, the
 *     same rule `roleIdMatchesNamespace` applies to delegated role assignment), and every role
 *     must exist;
 *   * the level is the literal `spreadsheet:write`, fixed here and nowhere else — NOT read, because
 *     the first grant row on a sheet switches it to intersection mode and a read-only row would
 *     stop the floor from entering values (frontline plan); NOT admin;
 *   * ADD-ONLY: `ON CONFLICT DO NOTHING`, no DELETE, no downgrade. The service's source is pinned
 *     to contain exactly one INSERT and zero DELETE statements;
 *   * only a sheet whose objectId matches the project-sheet shape below AND whose id is the one
 *     derived for (the plugin's own project, that objectId) AND which the registry records as this
 *     plugin's and this project's. A hand-named sandbox twin, the canonical main table and another
 *     tenant's sheet all fail before any statement;
 *   * every grant that lands writes a config-revision row (entity `permission`, keyed by sheet and
 *     role) — the same history the operator-facing grant route writes.
 *
 * KNOWN COST, stated: table-level `spreadsheet:write` also opens field and view management on that
 * one sheet (permission-service applySheetPermissionScope). The floor already holds exactly that
 * level on today's sheet, so this is not a new exposure; the ADR records it (§11.7).
 */

/** The same rule plugins/plugin-integration-core/lib/stock-preparation-own-base.cjs holds. */
export const STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN = /^plm_stock_preparation_sandbox_p_[0-9a-f]{24}$/

/** The role namespace a grantable role must sit in (`stock-prep` or `stock-prep_<x>`). */
export const STOCK_PREPARATION_ROLE_NAMESPACE = 'stock-prep'

/** THE ONE permission level this port can write. A literal, never a parameter. */
export const STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE = 'spreadsheet:write' as const

export function isStockPreparationProjectSheetObjectId(value: unknown): value is string {
  return typeof value === 'string' && STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN.test(value)
}

export class StockPreparationProjectSheetGrantError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'StockPreparationProjectSheetGrantError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Normalize a caller's role list: strings only, trimmed, de-duplicated, order kept, and EVERY id
 * inside the stock-prep namespace. Refuses (422) rather than filters: a role outside the namespace
 * is a configuration fault the operator must see, not a row to skip silently.
 */
export function normalizeStockPreparationGrantRoleIds(roleIds: unknown): string[] {
  if (!Array.isArray(roleIds)) {
    throw new StockPreparationProjectSheetGrantError(422, 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLES_INVALID', 'roleIds must be an array of role ids', { field: 'roleIds' })
  }
  const out: string[] = []
  for (const raw of roleIds) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new StockPreparationProjectSheetGrantError(422, 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLES_INVALID', 'every role id must be a non-empty string', { field: 'roleIds' })
    }
    const id = raw.trim()
    if (!(id === STOCK_PREPARATION_ROLE_NAMESPACE || id.startsWith(`${STOCK_PREPARATION_ROLE_NAMESPACE}_`))) {
      throw new StockPreparationProjectSheetGrantError(
        422,
        'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE',
        `a project-sheet grant may name only roles in the "${STOCK_PREPARATION_ROLE_NAMESPACE}" namespace`,
        { field: 'roleIds', roleId: id, namespace: STOCK_PREPARATION_ROLE_NAMESPACE },
      )
    }
    if (!out.includes(id)) out.push(id)
  }
  return out
}
