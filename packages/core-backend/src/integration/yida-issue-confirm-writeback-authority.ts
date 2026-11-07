import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { lockAuthorizationVersionsForAdmission } from '../multitable/authz-version-protocol'
import { resolveSheetCapabilitiesForAccess } from '../multitable/permission-service'
import { AutomationActorAuthorityError, assertAutomationIntegrationActor } from './automation-live-authority'

/**
 * YiDa 发料确认日期回写 — THE HOST LIVE RE-CHECK (design baseline v2.3 §7.3, decision D13 a; slice Y9).
 *
 * The plugin's write-back executor (plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs) calls this
 * under the sheet write lease, right before it reads the registered project sheet and patches its one machine cell.
 * The plugin db cannot read users / roles, so the host answers, from rows it locks in ONE fresh read-committed
 * transaction of its own (never the send's, never a request, never the 60 s RBAC cache):
 *   1. the actor is still a LIVE integration admin of this tenant — `assertAutomationIntegrationActor`, the exact
 *      proof every owner route runs (DENIED → false);
 *   2. a stock-prep operator code reaches the actor THROUGH A ROLE (D13 a, "经角色授予"): role-granted
 *      `stock-prep:admin`, or role-granted `stock-prep:operate` together with `stock-prep:read` (the operate tier of
 *      stock-preparation-workbench-access.cjs). A direct `user_permissions` grant or the platform-admin rung of that
 *      ladder does NOT count here (T-level default, fail closed; owner may veto within 24 h);
 *   3. the actor can still READ the registered sheet ("表权限"): the sheet capabilities every multitable read derives
 *      (`resolveSheetCapabilitiesForAccess`) from the codes and admin-ness the D21 helper locked on this transaction.
 * A sheet that is no longer live, a lock conflict, a missing protocol or any query failure is NOT a verdict: it
 * throws (the executor reports the row retryable and records nothing). Values-free: no error carries a value.
 *
 * The write itself is the plugin's SDK machine write under its lease and host fence (the carry-confirm precedent),
 * not the actor's own multitable write permission; this check decides only whether the actor may still cause it.
 */
export type YidaIssueConfirmRecheckActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
export type YidaIssueConfirmRecheckDatabase = { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
export type YidaIssueConfirmRecheck = (database: YidaIssueConfirmRecheckDatabase, actor: YidaIssueConfirmRecheckActor,
  input: unknown) => Promise<boolean>

const ID = /^[^\u0000-\u001f\u007f]{1,128}$/u
// The operate tier, role-granted only: stock-prep:admin, or operate AND read (the conjunction of the workbench ladder).
export const ISSUE_CONFIRM_ROLE_CODES = Object.freeze(['stock-prep:admin', 'stock-prep:operate', 'stock-prep:read'])

export class YidaIssueConfirmRecheckError extends Error {
  readonly code = 'YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE'
  constructor() {
    super('YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE')
    this.name = 'YidaIssueConfirmRecheckError'
  }
}
function unavailable(): never { throw new YidaIssueConfirmRecheckError() }
function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !ID.test(value)) unavailable()
  return value
}

/** Pure: does this set of ROLE-GRANTED codes reach the write-back's operator tier? */
export function issueConfirmRoleGrantSatisfied(roleCodes: Iterable<string>): boolean {
  const codes = new Set(roleCodes)
  return codes.has('stock-prep:admin') || (codes.has('stock-prep:operate') && codes.has('stock-prep:read'))
}

export const yidaIssueConfirmLiveRecheck: YidaIssueConfirmRecheck = async (database, actor, input) => {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Record<string, unknown> | null
  if (!record) unavailable()
  const tenantId = opaque(record.tenantId), ownerId = opaque(record.ownerId), sheetId = opaque(record.sheetId)
  // The executor's scope is the authenticated owner; a mismatch is a wiring fault, never a verdict.
  if (tenantId !== actor.tenantId || ownerId !== actor.actorId || actor.workspaceId !== null) unavailable()
  try {
    return await database.transaction(async trx => {
      await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      // The D21 helper's locked rows (sheet + subject version rows, then the live-authority rows, FOR SHARE).
      const locked = await lockAuthorizationVersionsForAdmission(trx, { sheetIds: [sheetId], actorId: ownerId, tenantId })
      try {
        await assertAutomationIntegrationActor(trx, { actorId: ownerId, tenantId, workspaceId: null })
      } catch (error) {
        if (error instanceof AutomationActorAuthorityError && error.code === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') return false
        throw error
      }
      const roleCodes = locked.authority.rolePermissions.map(row => row.permissionCode.trim())
      if (!issueConfirmRoleGrantSatisfied(roleCodes)) return false
      const query = (sql: string, params?: unknown[]) => trx.query(sql, params)
      const { capabilities, sheetLiveness } = await resolveSheetCapabilitiesForAccess(query, sheetId, {
        userId: ownerId, permissions: [...locked.authority.permissionCodes], isAdminRole: locked.authority.isAdmin === true,
        authenticatedTenantId: tenantId,
      })
      if (sheetLiveness !== 'live') unavailable()
      return capabilities.canRead === true
    })
  } catch (error) {
    if (error instanceof YidaIssueConfirmRecheckError) throw error
    unavailable()
  }
}
