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
 * not the actor's own multitable write permission; this check decides only whether the actor may still cause it. The
 * same verdict is decided once more INSIDE that write's own transaction (the WRITE CONDITION, below), so a revocation
 * or a project archive that commits after this answer and before the date's COMMIT can no longer let the date in.
 */
export type YidaIssueConfirmRecheckActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
export type YidaIssueConfirmRecheckDatabase = { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
export type YidaIssueConfirmWriteCondition = Readonly<{
  tenantId: string
  ownerId: string
  sheetId: string
  projectNo: string
  trace: Readonly<{
    recordId: string
    targetRef: string
    ledgerId: string
    outcome: 'written' | 'written_inactive'
    date: string
    timeZone: string
  }>
}>
export type YidaIssueConfirmWriteConditionFactory = (actor: YidaIssueConfirmRecheckActor, input: unknown) => YidaIssueConfirmWriteCondition
export type YidaIssueConfirmRecheck = (database: YidaIssueConfirmRecheckDatabase, actor: YidaIssueConfirmRecheckActor,
  input: unknown) => Promise<boolean>

// eslint-disable-next-line no-control-regex -- Scope identifiers must explicitly reject embedded ASCII controls.
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

/**
 * THE VERDICT on an open READ COMMITTED transaction `trx` (checks 1–3 above; the D21 helper's FOR SHARE locks stay held
 * until that transaction ends). Shared by the standalone re-check (its own transaction, below) and the write condition
 * (the record write's own transaction, {@link prepareYidaIssueConfirmWriteCondition}). false = a verdict (revoked); a
 * throw = no verdict.
 */
async function issueConfirmAuthorityVerdict(trx: Queryable,
  scope: Readonly<{ tenantId: string; ownerId: string; sheetId: string }>): Promise<boolean> {
  const { tenantId, ownerId, sheetId } = scope
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
      return issueConfirmAuthorityVerdict(trx, { tenantId, ownerId, sheetId })
    })
  } catch (error) {
    if (error instanceof YidaIssueConfirmRecheckError) throw error
    unavailable()
  }
}

// ── THE WRITE CONDITION (#6812 review P2: the date never lands on lapsed authority or a lapsed project state) ─────────
//
// The re-check above answers in a transaction of its own; the date is written later, in the host's record write
// transaction (index.ts `records.patchRecord`, behind the plugin write fence). A revocation or a project archive that
// committed between the two would still have let the date in: the fence proves only the sheet lease, the
// version-conditional patch only the record. So the executor carries a WRITE CONDITION on its one patch, and the host
// decides both facts again INSIDE THE WRITE TRANSACTION, after the lease fence and before the record UPDATE,
// holding their row locks until COMMIT:
//   1. the project registry row (integration_stock_prep_project_target, by tenant + project number) FOR SHARE: exactly
//      one row, `active`, registered on the sheet being written — else YIDA_ISSUE_CONFIRM_WRITE_PROJECT_INACTIVE (409);
//   2. the full live verdict above (the D21 helper's version and authority rows FOR SHARE, the live actor, the
//      role-granted operator tier, sheet read) — false → YIDA_ISSUE_CONFIRM_WRITE_AUTHORITY_REVOKED (409).
// Any failure while deciding them (a lock conflict, a missing protocol, a sheet no longer live, a query fault) is
// YIDA_ISSUE_CONFIRM_WRITE_CONDITION_UNAVAILABLE (503). On every refusal nothing is written (the transaction rolls back)
// and the executor reports the row retryable with that code and no trace; the next run decides it again and records
// the terminal outcome (project_archived / project_absent / sheet_mismatch before the lease, permission_revoked under it).
// WHY ROW LOCKS ARE ENOUGH (PostgreSQL, READ COMMITTED; the plugin-write-fence argument). The archive (the
// project-target store's transition) takes that registry row FOR UPDATE; a revocation deletes or updates a user_roles /
// role_permissions / user_permissions / users / user_orgs / user_namespace_admissions row the verdict locked FOR SHARE
// (and, through the D21 triggers, bumps the subject or sheet version row the verdict also locked FOR SHARE). Either
// conflicts with FOR SHARE. Committed first → this transaction waits for it, reads the committed state, refuses.
// This transaction first → the archive or revocation waits until the date has committed: the date landed while both
// facts still held.
// LOCK ORDER: lease row → registry row → platform sheet writer fences → D21 version/authority rows → record.
// Project template repair holds the registry row while taking the platform fence. Sheet permission configuration
// writers take the platform fence before bumping the sheet version, so the live verdict runs after that fence.
// The condition is host-minted (frozen, branded) for the authenticated owner only — the plugin cannot name another actor
// — and it binds the sheet: handed to a write of another sheet, or to a write without a fence, it is refused (403).

export const YIDA_ISSUE_CONFIRM_WRITE_CONDITION_CODES = Object.freeze({
  NOT_ALLOWED: 'YIDA_ISSUE_CONFIRM_WRITE_CONDITION_NOT_ALLOWED',
  AUTHORITY_REVOKED: 'YIDA_ISSUE_CONFIRM_WRITE_AUTHORITY_REVOKED',
  PROJECT_INACTIVE: 'YIDA_ISSUE_CONFIRM_WRITE_PROJECT_INACTIVE',
  UNAVAILABLE: 'YIDA_ISSUE_CONFIRM_WRITE_CONDITION_UNAVAILABLE',
})

// The registry read: fixed SQL on the plugin's own registry table (migration 087) — the plugin-write-fence precedent.
export const YIDA_ISSUE_CONFIRM_WRITE_PROJECT_SQL = 'SELECT status, sheet_id FROM integration_stock_prep_project_target'
  + ' WHERE tenant_id = $1 AND project_no = $2 FOR SHARE'

export class YidaIssueConfirmWriteConditionError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'YidaIssueConfirmWriteConditionError'
    this.status = status
    this.code = code
  }
}

const writeConditions = new WeakSet<object>()

/**
 * Mint the write condition for the authenticated owner `actor` (the host owner runtime hands this to the executor next
 * to the re-check). The scope includes the bound record and the success trace. A scope outside the owner's is a wiring
 * fault (YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE), never a condition.
 */
export const createYidaIssueConfirmWriteCondition: YidaIssueConfirmWriteConditionFactory = (actor, input) => {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Record<string, unknown> | null
  if (!record) unavailable()
  const tenantId = opaque(record.tenantId), ownerId = opaque(record.ownerId), sheetId = opaque(record.sheetId)
  const projectNo = opaque(record.projectNo)
  if (tenantId !== actor.tenantId || ownerId !== actor.actorId || actor.workspaceId !== null) unavailable()
  const { outcome } = record
  const date = opaque(record.date)
  if ((outcome !== 'written' && outcome !== 'written_inactive') || !/^\d{4}-\d{2}-\d{2}$/.test(date)) unavailable()
  const trace = Object.freeze({
    recordId: opaque(record.recordId),
    targetRef: opaque(record.targetRef),
    ledgerId: opaque(record.ledgerId),
    outcome,
    date,
    timeZone: opaque(record.timeZone),
  })
  const condition = Object.freeze({ tenantId, ownerId, sheetId, projectNo, trace })
  writeConditions.add(condition)
  return condition
}

type WriteQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Lock and check the project after the plugin lease fence. The caller must run the returned authority check
 * on this same READ COMMITTED transaction after taking the platform writer fences and before changing the record.
 */
export async function prepareYidaIssueConfirmWriteCondition(query: WriteQuery, condition: unknown,
  binding: Readonly<{ sheetId: unknown; fenced: boolean }>): Promise<(() => Promise<void>) | undefined> {
  if (condition === undefined) return
  const codes = YIDA_ISSUE_CONFIRM_WRITE_CONDITION_CODES
  if (!condition || typeof condition !== 'object' || !writeConditions.has(condition)) {
    throw new YidaIssueConfirmWriteConditionError(403, codes.NOT_ALLOWED)
  }
  const bound = condition as YidaIssueConfirmWriteCondition
  if (binding.fenced !== true || binding.sheetId !== bound.sheetId) throw new YidaIssueConfirmWriteConditionError(403, codes.NOT_ALLOWED)
  let projects: unknown
  try {
    projects = (await query(YIDA_ISSUE_CONFIRM_WRITE_PROJECT_SQL, [bound.tenantId, bound.projectNo]))?.rows
  } catch {
    throw new YidaIssueConfirmWriteConditionError(503, codes.UNAVAILABLE)
  }
  const project = Array.isArray(projects) && projects.length === 1 ? projects[0] as Record<string, unknown> : null
  if (!project || project.status !== 'active' || project.sheet_id !== bound.sheetId) {
    throw new YidaIssueConfirmWriteConditionError(409, codes.PROJECT_INACTIVE)
  }

  return async () => {
    const trx: Queryable = {
      query: async (sql, params) => {
        const result = await query(sql, params)
        return { rows: (Array.isArray(result?.rows) ? result.rows : []) as Array<Record<string, unknown>>, rowCount: result?.rowCount ?? null }
      },
    }
    let allowed: boolean
    try {
      allowed = await issueConfirmAuthorityVerdict(trx, bound)
    } catch {
      throw new YidaIssueConfirmWriteConditionError(503, codes.UNAVAILABLE)
    }
    if (!allowed) throw new YidaIssueConfirmWriteConditionError(409, codes.AUTHORITY_REVOKED)
  }
}

/** Append the success trace in the record transaction. A conflicting terminal outcome rolls the patch back. */
export async function recordYidaIssueConfirmWriteTrace(query: WriteQuery, condition: unknown, recordId: string): Promise<void> {
  if (condition === undefined) return
  const codes = YIDA_ISSUE_CONFIRM_WRITE_CONDITION_CODES
  if (!condition || typeof condition !== 'object' || !writeConditions.has(condition)) {
    throw new YidaIssueConfirmWriteConditionError(403, codes.NOT_ALLOWED)
  }
  const { tenantId, ownerId, sheetId, trace } = condition as YidaIssueConfirmWriteCondition
  if (recordId !== trace.recordId) throw new YidaIssueConfirmWriteConditionError(403, codes.NOT_ALLOWED)

  const result = await query(
    `INSERT INTO "integration_yida_issue_confirm_writeback"
      (ledger_id, tenant_id, owner_id, target_ref, sheet_id, outcome, written_date, time_zone)
     SELECT id, tenant_id, owner_id, target_ref, $5, $6, $7, $8
     FROM integration_yida_delivery_ledger
     WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 AND target_ref = $4
       AND workspace_id IS NULL AND status = 'acknowledged' AND intent = 'create'
       AND source_record_digest IS NOT NULL
     ON CONFLICT (ledger_id) DO NOTHING
     RETURNING ledger_id`,
    [trace.ledgerId, tenantId, ownerId, trace.targetRef, sheetId, trace.outcome, trace.date, trace.timeZone],
  )
  if (result.rows.length !== 1) throw new YidaIssueConfirmWriteConditionError(409, 'YIDA_ISSUE_CONFIRM_TRACE_CONFLICT')
}
