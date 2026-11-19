import { transaction, query } from '../db/pg'
import { isRoleAction, isExceptionAction } from './authorization-operation-contract'
import { writeAuthorizationException } from './authorization-exception-write'
import { removeMatchingLegacyPermission } from './legacy-permission-revoke'
import { isLastSignInPlatformAdmin } from './user-recycle'
import { AUTHORIZATION_INPUT_STATEMENTS, AUTHORIZATION_OPERATION_DEADLINE_MS, AuthorizationInputBusyError, withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'
import { assertAuthorizationOperationReadReady } from './authorization-operation-fence'
import { assignUserRoles, unassignUserRoles, isRoleAssignable, reviewDelegatedRoleCodes, delegatedRoleCodeRefusal } from '../rbac/role-assignment'
import { deriveDelegatedAdminNamespace, derivePermissionNamespace, roleIdMatchesNamespace } from '../rbac/namespace-admission'
import { disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces, writeUserNamespaceAdmission } from '../rbac/namespace-admission'
import { invalidateUserPerms } from '../rbac/service'
import { filterEnabledDelegationNamespaces } from './delegated-scope-activation'
import { calculateOperationImpact, canonicalOperationValue, expectedDelegationActivationReset, operationDigest, operationVersion, readOperationSnapshot } from './authorization-operation-snapshot'
import type { OperationQuery, OperationSnapshot } from './authorization-operation-snapshot'
import type { AuthorizationOperationCommitRequest, AuthorizationOperationLookup, AuthorizationOperationPreview, AuthorizationOperationReceipt, AuthorizationOperationRequest } from './authorization-operation-contract'

export type ReceiptRow = { target_user_id: string; action: AuthorizationOperationRequest; request_digest: string; receipt: AuthorizationOperationReceipt }
export class AuthorizationOperationError extends Error {
  constructor(readonly status: number, readonly code: string, message = 'Authorization operation refused') { super(message) }
}
const deny = (status: number, code: string): never => { throw new AuthorizationOperationError(status, code) }
export type AuthorizationOperationAccess = { kind: 'platform' } | { kind: 'delegated'; namespaces: string[]; roleNamespace: string | null; visibleRoleId: string | null; hideEffective: boolean }
function assertActiveActor(actor: Record<string, unknown> | undefined): void {
  if (!actor || actor.is_active !== true || actor.activation_status !== 'activated' || actor.deleted_at || actor.purged_at) return deny(403, 'FORBIDDEN')
}
/** Rights are derived only from the current fenced or repeatable-read snapshot. */
export function evaluateAuthorizationOperationAccess(snapshot: OperationSnapshot, actorId: string, input: AuthorizationOperationRequest, impact: AuthorizationOperationReceipt['impact']): AuthorizationOperationAccess {
  const actor=snapshot.actor ?? undefined
  assertActiveActor(actor)
  const roles=snapshot.memberships.filter(row=>row.user_id===actorId)
  if (isExceptionAction(input.action) && !roles.some(row=>row.role_id==='admin')) return deny(403,'FORBIDDEN')
  if (actor?.role==='admin' || roles.some(row=>row.role_id==='admin')) {
    if (!snapshot.target || snapshot.target.deleted_at || snapshot.target.purged_at) return deny(404, 'NOT_FOUND')
    return {kind:'platform'}
  }
  const witness=snapshot.delegatedWitness
  if (!witness) return deny(403,'FORBIDDEN')
  const allowed=(namespace:string) => witness.namespaces.includes(namespace) && witness.audience.some(item=>item.namespace===namespace && item.allowed)
  const proved=new Set<string>()
  let roleNamespace: string | null=null
  for (const change of impact.admissionChanges) {
    if (!allowed(change.namespace)) return deny(403,'FORBIDDEN')
    proved.add(change.namespace)
  }
  if (isRoleAction(input.action)) {
    const roleId=input.action.roleId
    if (!snapshot.roles.some(row=>row.id===roleId)) return deny(403,'FORBIDDEN')
    const codes=snapshot.rolePermissions.filter(row=>row.role_id===roleId).map(row=>row.permission_code)
    const namespace=witness.namespaces.find(ns => allowed(ns) && isRoleAssignable(roleId,{kind:'namespaces',namespaces:[ns]}) && !delegatedRoleCodeRefusal(reviewDelegatedRoleCodes(roleId,codes,[ns]),input.action.kind==='role.assign'?'assign':'unassign'))
    if (!namespace) return deny(403,'FORBIDDEN')
    roleNamespace=namespace
    proved.add(namespace)
  }
  if (proved.size===0 || !snapshot.target || snapshot.target.deleted_at || snapshot.target.purged_at) return deny(403,'FORBIDDEN')
  return {kind:'delegated',namespaces:[...proved].sort(),roleNamespace,visibleRoleId:isRoleAction(input.action) ? input.action.roleId : null,hideEffective:snapshot.target.role==='admin' || snapshot.memberships.some(row=>row.user_id===input.targetUserId && row.role_id==='admin')}
}
function explicitImpact(input: AuthorizationOperationRequest): AuthorizationOperationReceipt['impact'] {
  return {sourceChanges:[],admissionChanges:input.admissionChanges.map(item=>({namespace:item.namespace,before:null,after:item.enabled,cause:'explicit' as const})),scopeCleanup:[],effectiveBefore:[],effectiveAfter:[],retainedOtherGrants:[],warnings:[]}
}
export function redactAuthorizationOperationImpact(impact: AuthorizationOperationReceipt['impact'], access: AuthorizationOperationAccess): AuthorizationOperationReceipt['impact'] {
  if (access.kind==='platform') return impact
  const allowed=new Set(access.namespaces)
  const visible=(entry: AuthorizationOperationReceipt['impact']['effectiveBefore'][number]) => {
    const namespace=derivePermissionNamespace(entry.code)
    return !access.hideEffective && namespace !== null && allowed.has(namespace) && entry.sources.every(source=>source.kind !== 'profile' && (source.kind !== 'role' || (source.id !== null && source.id===access.visibleRoleId && roleIdMatchesNamespace(source.id,namespace))))
  }
  return {
    ...impact,
    admissionChanges: impact.admissionChanges.filter(item => allowed.has(item.namespace)),
    scopeCleanup: impact.scopeCleanup.filter(item => allowed.has(item.namespace)),
    effectiveBefore: impact.effectiveBefore.filter(visible),
    effectiveAfter: impact.effectiveAfter.filter(visible),
    retainedOtherGrants: impact.retainedOtherGrants.filter(visible),
    // A whole-profile warning can disclose a grant omitted above.
    warnings: impact.warnings.filter(warning => warning === 'attendance_employee_opt_out'),
  }
}
function assertOperationInputs(input: AuthorizationOperationRequest, snapshot: OperationSnapshot, actorId: string): void {
  if ((input.action.kind==='direct.grant' || input.action.kind==='template.apply') && !input.reason?.trim()) return deny(400,'REASON_REQUIRED')
  if (input.targetUserId === actorId && (input.action.kind === 'role.assign' || input.action.kind === 'direct.grant' || input.action.kind === 'template.apply' || input.admissionChanges.some(item => item.enabled))) return deny(403, 'SELF_WIDENING_FORBIDDEN')
  const roleIds = [...new Set(snapshot.memberships.map(row => String(row.role_id)).concat(isRoleAction(input.action) ? [input.action.roleId] : []))].sort()
  const existing = snapshot.roles.map(row => String(row.id)).sort()
  if (canonicalOperationValue(roleIds) !== canonicalOperationValue(existing)) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
  if (input.action.kind==='template.apply' && !snapshot.template) return deny(404,'TEMPLATE_NOT_FOUND')
  if ((input.action.kind==='template.apply' || input.action.kind==='direct.grant') && canonicalOperationValue(snapshot.permissionCatalog.map(row=>row.code))!==canonicalOperationValue(snapshot.requestedCodes)) return deny(400,'UNKNOWN_PERMISSION')
}
async function readActorOnly(run: OperationQuery, actorId: string): Promise<void> {
  const users = await run(`SELECT role, COALESCE(is_active, TRUE) AS is_active, activation_status,
    (to_jsonb(users)->>'deleted_at') AS deleted_at, (to_jsonb(users)->>'purged_at') AS purged_at FROM users WHERE id::text = $1`, [actorId])
  const roles = await run('SELECT role_id FROM user_roles WHERE user_id::text = $1', [actorId])
  const actor=users.rows[0]
  assertActiveActor(actor)
  if (actor.role === 'admin' || roles.rows.some(row => row.role_id === 'admin')) return
  const namespaces = roles.rows.map(row => deriveDelegatedAdminNamespace(String(row.role_id))).filter((value): value is string => value !== null)
  if ((await filterEnabledDelegationNamespaces(run, actorId, namespaces)).length === 0) return deny(403, 'FORBIDDEN')
}
async function readReceipt(run: OperationQuery, actorId: string, id: string): Promise<ReceiptRow | null> {
  const rows = await run("SELECT target_user_id, action, request_digest, receipt FROM authorization_operation_receipts WHERE actor_id = $1 AND client_operation_id = $2::uuid AND request_digest <> 'legacy'", [actorId, id])
  return (rows.rows[0] as ReceiptRow | undefined) ?? null
}
async function withOperationDeadline<T>(commit: boolean, work: (signal: AbortSignal, deadlineAt: number) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const deadlineAt = Date.now() + AUTHORIZATION_OPERATION_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new AuthorizationOperationError(503, commit ? 'AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN' : 'AUTHORIZATION_OPERATION_UNAVAILABLE'))
    }, AUTHORIZATION_OPERATION_DEADLINE_MS)
  })
  try { return await Promise.race([work(controller.signal, deadlineAt), timeout]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
async function consistentRead<T>(work: (query: OperationQuery) => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    return await transaction(async client => {
      if (signal.aborted) throw new AuthorizationOperationError(503, 'AUTHORIZATION_OPERATION_UNAVAILABLE')
      const raw = (client as unknown as { __rawClient?: { connection?: { stream?: { destroy(): void } } } }).__rawClient
      const stream = raw?.connection?.stream
      if (!stream) throw new AuthorizationOperationError(503, 'AUTHORIZATION_OPERATION_UNAVAILABLE')
      abort = () => stream.destroy()
      signal.addEventListener('abort', abort, { once: true })
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SELECT pg_catalog.set_config('lock_timeout','500',true), pg_catalog.set_config('statement_timeout','2500',true)")
      const run: OperationQuery = (sql, params) => client.query(sql, params)
      if (!await assertAuthorizationOperationReadReady(run, AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)) throw new AuthorizationInputBusyError('lock_timeout')
      return work(run)
    })
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}
export async function previewAuthorizationOperation(actorId: string, input: AuthorizationOperationRequest): Promise<AuthorizationOperationPreview> {
  return withOperationDeadline(false, signal => consistentRead(async run => {
    const snapshot = await readOperationSnapshot(run, actorId, input)
    evaluateAuthorizationOperationAccess(snapshot,actorId,input,explicitImpact(input))
    const impact=calculateOperationImpact(input,snapshot)
    const access=evaluateAuthorizationOperationAccess(snapshot,actorId,input,impact)
    assertOperationInputs(input, snapshot, actorId)
    return { expectedVersion: operationVersion(actorId, input, snapshot), impact: redactAuthorizationOperationImpact(impact,access) }
  }, signal))
}
export async function getAuthorizationOperation(actorId: string, clientOperationId: string): Promise<AuthorizationOperationLookup> {
  return withOperationDeadline(false, signal => consistentRead(async run => {
    await readActorOnly(run, actorId)
    const row = await readReceipt(run, actorId, clientOperationId)
    if (!row) return { status: 'unknown_or_pending', clientOperationId }
    const snapshot = await readOperationSnapshot(run, actorId, row.action)
    const access=evaluateAuthorizationOperationAccess(snapshot,actorId,row.action,row.receipt.impact)
    return { status: 'committed', clientOperationId, receipt: {...row.receipt,impact:redactAuthorizationOperationImpact(row.receipt.impact,access)} }
  }, signal))
}
class ReceiptReplan extends Error {}
export async function commitAuthorizationOperation(actorId: string, input: AuthorizationOperationCommitRequest, syncLegacyAdminProfile: (userId: string, enabled: boolean, query: OperationQuery) => Promise<void>): Promise<AuthorizationOperationLookup> {
  return withOperationDeadline(true, (signal, deadlineAt) => commitAuthorizationOperationWithinDeadline(actorId, input, syncLegacyAdminProfile, signal, deadlineAt))
}
async function commitAuthorizationOperationWithinDeadline(actorId: string, input: AuthorizationOperationCommitRequest, syncLegacyAdminProfile: (userId: string, enabled: boolean, query: OperationQuery) => Promise<void>, signal: AbortSignal, deadlineAt: number): Promise<AuthorizationOperationLookup> {
  const { clientOperationId, expectedVersion, ...request } = input
  const requestDigest = operationDigest({ actorId, expectedVersion, request })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // This pre-read plans locks only; no authority or success is decided from it.
    const known = await readReceipt((sql, params) => query(sql, params), actorId, clientOperationId)
    if (signal.aborted) return deny(503, 'AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN')
    const actual = known?.action ?? request
    const ids = [...new Set([actorId, actual.targetUserId])].sort()
    const memberships = await query<{ role_id: string }>('SELECT DISTINCT role_id::text AS role_id FROM user_roles WHERE user_id::text = ANY($1::text[])', [ids])
    const plannedRoles = [...new Set([...memberships.rows.map(row => row.role_id), ...(isRoleAction(actual.action) ? [actual.action.roleId] : [])])].sort()
    if (signal.aborted) return deny(503, 'AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN')
    try {
      const subjects = Object.freeze(ids)
      const plan = Object.freeze({
        intent: 'AUTHORIZATION_OPERATION' as const,
        operation: Object.freeze({ actorId, clientOperationId }),
        userIds: subjects,
        admissionUserIds: subjects,
        roleIds: Object.freeze(plannedRoles),
        witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),
      })
      const result = await withAuthorizationInputTransaction(plan, async tx => {
        if (!tx.locked.has(actorId)) return deny(403, 'FORBIDDEN')
        const stored = await readReceipt(tx.query, actorId, clientOperationId)
        if (stored && stored.target_user_id !== actual.targetUserId) throw new ReceiptReplan()
        const checked = stored?.action ?? actual
        const snapshot = await readOperationSnapshot(tx.query, actorId, checked)
        if (!stored) evaluateAuthorizationOperationAccess(snapshot,actorId,checked,explicitImpact(checked))
        const impact=stored?.receipt.impact ?? calculateOperationImpact(checked,snapshot)
        const access=evaluateAuthorizationOperationAccess(snapshot,actorId,checked,impact)
        if (!tx.locked.has(actual.targetUserId)) return deny(access.kind==='platform' ? 404 : 403, access.kind==='platform' ? 'NOT_FOUND' : 'FORBIDDEN')
        if (stored) {
          if (stored.request_digest !== requestDigest) return deny(409, 'IDEMPOTENCY_CONFLICT')
          return { status: 'committed' as const, clientOperationId, receipt: {...stored.receipt,impact:redactAuthorizationOperationImpact(stored.receipt.impact,access)}, invalidate: false }
        }
        const collision=await tx.query("SELECT 1 FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2::uuid AND request_digest='legacy'",[actorId,clientOperationId])
        if (collision.rows.length) return deny(409,'IDEMPOTENCY_CONFLICT')
        const roleIds = [...new Set(snapshot.memberships.map(row => String(row.role_id)).concat(isRoleAction(checked.action) ? [checked.action.roleId] : []))].sort()
        if (canonicalOperationValue(roleIds) !== canonicalOperationValue(plannedRoles)) return deny(409, 'STALE_PREVIEW')
        assertOperationInputs(checked, snapshot, actorId)
        if (operationVersion(actorId, request, snapshot) !== expectedVersion) return deny(409, 'STALE_PREVIEW')
        if (isRoleAction(request.action)) {
          const { roleId, kind } = request.action
          if (kind === 'role.revoke' && roleId === 'admin' && await isLastSignInPlatformAdmin(tx, request.targetUserId)) return deny(409, 'LAST_PLATFORM_ADMIN')
          if (kind === 'role.assign') await assignUserRoles({ userIds: [request.targetUserId], roleId, assignmentSource: 'manual', scope: access.kind==='platform' ? {kind:'platform-admin'} : {kind:'namespaces',namespaces:access.roleNamespace ? [access.roleNamespace] : []}, executor: tx })
          else {
            await unassignUserRoles({ userIds: [request.targetUserId], roleId, scope: access.kind==='platform' ? {kind:'platform-admin'} : {kind:'namespaces',namespaces:access.roleNamespace ? [access.roleNamespace] : []}, executor: tx })
            await disableNamespaceAdmissionsWithoutRoles({ userId: request.targetUserId, namespaces: await listRoleNamespaces(roleId, tx.query), actorId, source: 'role_unassigned', revokedRoleId: roleId }, tx.query)
          }
          if (roleId === 'admin') {
            await syncLegacyAdminProfile(request.targetUserId, kind === 'role.assign', tx.query)
          }
        }
        if (isExceptionAction(request.action)) {
          const action=request.action.kind==='template.apply' ? {kind:'template.grant' as const,codes:snapshot.requestedCodes} : request.action
          await writeAuthorizationException(tx, Object.freeze({
            actorId, userId: request.targetUserId, plan, action,
            expectedDirectCodes: snapshot.direct.map(row => String(row.permission_code)),
            expectedLegacy: { value: snapshot.target?.permissions },
          }))
        }
        for (const change of request.admissionChanges) await writeUserNamespaceAdmission({ userId: request.targetUserId, namespace: change.namespace, enabled: change.enabled, actorId, source: access.kind==='platform' ? 'platform_admin' : 'delegated_admin' }, tx)
        const after = await readOperationSnapshot(tx.query, actorId, request)
        const expectedMemberships = snapshot.memberships.filter(row => !(isRoleAction(request.action) && row.user_id === request.targetUserId && row.role_id === request.action.roleId))
        if (request.action.kind === 'role.assign') expectedMemberships.push({ user_id: request.targetUserId, role_id: request.action.roleId })
        const membershipKey = (row: Record<string, unknown>) => `${String(row.user_id)}\u0000${String(row.role_id)}`
        if (canonicalOperationValue(expectedMemberships.map(membershipKey).sort()) !== canonicalOperationValue(after.memberships.map(membershipKey).sort())) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        for (const change of impact.admissionChanges) {
          const row = after.admissions.find(item => item.namespace === change.namespace)
          if (!row || row.enabled !== change.after) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
          if (change.cause === 'role_revoke' && row.source !== 'role_unassigned') return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        }
        const changedNamespaces = new Set(impact.admissionChanges.map(change => change.namespace))
        if (canonicalOperationValue(snapshot.admissions.filter(row => !changedNamespaces.has(String(row.namespace)))) !== canonicalOperationValue(after.admissions.filter(row => !changedNamespaces.has(String(row.namespace))))) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        const expectedDepartments = snapshot.departmentScopes.filter(row => !impact.scopeCleanup.some(removed => removed.kind === 'department' && removed.id === String(row.id)))
        const expectedGroups = snapshot.groupScopes.filter(row => !impact.scopeCleanup.some(removed => removed.kind === 'member_group' && removed.id === String(row.id)))
        if (canonicalOperationValue(expectedDepartments) !== canonicalOperationValue(after.departmentScopes) || canonicalOperationValue(expectedGroups) !== canonicalOperationValue(after.groupScopes)) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        const resetNamespace = expectedDelegationActivationReset(request, snapshot)
        const isResetRow = (row: Record<string, unknown>) => row.admin_user_id === request.targetUserId && row.namespace === resetNamespace
        if (canonicalOperationValue(snapshot.delegationActivations.filter(row => !isResetRow(row))) !== canonicalOperationValue(after.delegationActivations.filter(row => !isResetRow(row)))) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        if (resetNamespace) {
          const current = after.delegationActivations.find(isResetRow)
          const previous = snapshot.delegationActivations.find(isResetRow)
          if (!current || current.enabled !== false || typeof current.revision !== 'string' || current.revision === previous?.revision) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        }
        if (isRoleAction(request.action) && request.action.roleId === 'admin') {
          const enabled = request.action.kind === 'role.assign'
          if (after.target?.is_admin !== enabled || (enabled && after.target?.role !== 'admin') || (!enabled && after.target?.role === 'admin')) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        }
        const directCodes=new Set(snapshot.direct.map(row=>String(row.permission_code)))
        if (request.action.kind==='direct.grant' || request.action.kind==='template.apply') for (const code of snapshot.requestedCodes) directCodes.add(code)
        if (request.action.kind==='direct.revoke') directCodes.delete(request.action.code)
        if (canonicalOperationValue([...directCodes].sort())!==canonicalOperationValue(after.direct.map(row=>String(row.permission_code)).sort())) return deny(409,'AUTHORIZATION_INPUT_INCOMPLETE')
        const expectedLegacy=request.action.kind==='legacy.revoke' ? removeMatchingLegacyPermission(snapshot.target?.permissions,request.action.code).next : snapshot.target?.permissions
        if (canonicalOperationValue(expectedLegacy)!==canonicalOperationValue(after.target?.permissions)) return deny(409,'AUTHORIZATION_INPUT_INCOMPLETE')
        const actualEffective = calculateOperationImpact({ targetUserId: request.targetUserId, action: { kind: 'admission.set' }, admissionChanges: [] }, after).effectiveBefore
        if (canonicalOperationValue(actualEffective) !== canonicalOperationValue(impact.effectiveAfter)) return deny(409, 'AUTHORIZATION_INPUT_INCOMPLETE')
        const receipt: AuthorizationOperationReceipt = { targetUserId: request.targetUserId, action: request.action, impact, resultVersion: operationVersion(actorId, request, after) }
        await tx.query(`INSERT INTO authorization_operation_receipts (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt) VALUES ($1,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb)`, [actorId, clientOperationId, requestDigest, expectedVersion, request.targetUserId, JSON.stringify(request), JSON.stringify(receipt)])
        await tx.query(`INSERT INTO authorization_operation_audit (actor_id, client_operation_id, reason, reason_origin, impact) VALUES ($1,$2::uuid,$3,$4,$5::jsonb)`, [actorId, clientOperationId, request.reason ?? null, request.reason ? 'provided' : 'not_required', JSON.stringify(impact)])
        return { status: 'committed' as const, clientOperationId, receipt: {...receipt,impact:redactAuthorizationOperationImpact(receipt.impact,access)}, invalidate: true }
      }, { signal, deadlineAt })
      if (result.invalidate) invalidateUserPerms(request.targetUserId)
      return { status: result.status, clientOperationId, receipt: result.receipt }
    } catch (error) {
      if (error instanceof ReceiptReplan) continue
      throw error
    }
  }
  return deny(409, 'AUTHORIZATION_INPUT_BUSY')
}
