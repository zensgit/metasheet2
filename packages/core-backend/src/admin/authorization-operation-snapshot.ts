import { createHash } from 'node:crypto'
import { getPermissionTemplate } from '../auth/permission-templates'
import { isRoleAction } from './authorization-operation-contract'
import { excludeDisabledDelegationNamespaces, isDelegatedScopeActivationEnabled } from './delegated-scope-activation'
import { removeMatchingLegacyPermission } from './legacy-permission-revoke'
import { isUserWithinDelegatedScope } from './authorization-operation-audience'
import { deriveDelegatedAdminNamespace, deriveGrantNamespaces, derivePermissionNamespace, roleIdMatchesNamespace } from '../rbac/namespace-admission'
import type { AuthorizationOperationImpact, AuthorizationOperationPermission, AuthorizationOperationRequest } from './authorization-operation-contract'

export class OperationAdmissionConflict extends Error {
  readonly status = 400
  readonly code = 'ADMISSION_CONFLICT'
  constructor() { super('Conflicting admission changes') }
}

export type OperationQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type Row = Record<string, unknown>
export type OperationSnapshot = {
  actor: Row | null
  target: Row | null
  memberships: Row[]
  roles: Row[]
  rolePermissions: Row[]
  requestedCodes: string[]
  permissionCatalog: Row[]
  template: { id: string; name: string; description: string; productMode: string; permissions: string[]; presetId: string | null; roleId: string | null } | null
  direct: Row[]
  admissions: Row[]
  departmentScopes: Row[]
  groupScopes: Row[]
  delegationActivations: Row[]
  delegationActivationEnabled: boolean
  delegatedWitness: { namespaces: string[]; audience: Array<{ namespace: string; allowed: boolean }>; scopes: Row[]; groups: Row[]; departments: Row[]; targetLinks: Row[]; targetGroups: Row[] } | null
  exactDepartment: string | null
  policy: { roleNamespaces: Array<{ roleId: string; namespaces: string[] }>; codeNamespaces: Array<{ code: string; namespace: string | null }> }
}

/** Every collection is bounded; an incomplete witness is never presented as a preview. */
async function bounded(query: OperationQuery, sql: string, params: unknown[]): Promise<Row[]> {
  const result = await query(sql, params)
  if (result.rows.length > 1000) throw new Error('AUTHORIZATION_OPERATION_WITNESS_LIMIT')
  return result.rows
}
export async function readOperationSnapshot(query: OperationQuery, actorId: string, input: AuthorizationOperationRequest): Promise<OperationSnapshot> {
  const subjectIds = [...new Set([actorId, input.targetUserId])].sort()
  const users = await bounded(query, `SELECT id::text AS id, xmin::text AS row_version, created_at::text AS created_at, role, is_admin, COALESCE(is_active, TRUE) AS is_active, activation_status,
    (to_jsonb(users)->>'deleted_at') AS deleted_at, (to_jsonb(users)->>'purged_at') AS purged_at,
    COALESCE(access_generation, 0)::text AS access_generation, to_jsonb(permissions) AS permissions
    FROM users WHERE id::text = ANY($1::text[]) ORDER BY id::text LIMIT 1001`, [subjectIds])
  const memberships = await bounded(query, 'SELECT user_id::text AS user_id, role_id::text AS role_id FROM user_roles WHERE user_id::text = ANY($1::text[]) ORDER BY user_id::text, role_id::text LIMIT 1001', [subjectIds])
  const roleIds = [...new Set([...memberships.map(row => String(row.role_id)), ...(isRoleAction(input.action) ? [input.action.roleId] : [])])].sort()
  const roles = await bounded(query, 'SELECT id::text AS id, xmin::text AS row_version, updated_at::text AS updated_at FROM roles WHERE id::text = ANY($1::text[]) ORDER BY id::text LIMIT 1001', [roleIds])
  const rolePermissions = await bounded(query, 'SELECT role_id::text AS role_id, permission_code FROM role_permissions WHERE role_id::text = ANY($1::text[]) ORDER BY role_id::text, permission_code LIMIT 1001', [roleIds])
  const direct = await bounded(query, 'SELECT permission_code FROM user_permissions WHERE user_id::text = $1 ORDER BY permission_code LIMIT 1001', [input.targetUserId])
  const definition=input.action.kind==='template.apply' ? getPermissionTemplate(input.action.templateId) : null
  const template=definition ? {...definition,permissions:[...definition.permissions].sort()} : null
  const requestedCodes=input.action.kind==='template.apply' ? template?.permissions ?? [] : ('code' in input.action ? [input.action.code] : [])
  const permissionCatalog=await bounded(query,'SELECT code, xmin::text AS row_version, to_jsonb(p) AS definition FROM permissions p WHERE code=ANY($1::text[]) ORDER BY code LIMIT 1001',[requestedCodes])
  const admissions = await bounded(query, 'SELECT namespace, enabled, source, granted_by::text AS granted_by, updated_by::text AS updated_by, updated_at::text AS updated_at FROM user_namespace_admissions WHERE user_id::text = $1 ORDER BY namespace LIMIT 1001', [input.targetUserId])
  const departmentScopes = await bounded(query, 'SELECT id::text AS id, namespace, directory_department_id::text AS directory_department_id, include_children FROM delegated_role_admin_scopes WHERE admin_user_id::text = $1 ORDER BY namespace, id::text LIMIT 1001', [input.targetUserId])
  const groupScopes = await bounded(query, 'SELECT id::text AS id, namespace, group_id::text AS group_id FROM delegated_role_admin_member_groups WHERE admin_user_id::text = $1 ORDER BY namespace, id::text LIMIT 1001', [input.targetUserId])
  const delegationActivations = await bounded(query, 'SELECT admin_user_id, namespace, enabled, revision::text AS revision FROM delegated_role_admin_activation WHERE admin_user_id = ANY($1::text[]) ORDER BY admin_user_id, namespace LIMIT 1001', [subjectIds])
  const target = users.find(row => row.id === input.targetUserId) ?? null
  const policyCodes = [...new Set([...rolePermissions.map(row => String(row.permission_code ?? '')), ...direct.map(row => String(row.permission_code ?? '')), ...(Array.isArray(target?.permissions) ? target.permissions.filter((item): item is string => typeof item === 'string') : [])].filter(Boolean))].sort()
  const policy = {
    roleNamespaces: roleIds.map(roleId => ({ roleId, namespaces: deriveGrantNamespaces({ roleId, permissionCodes: rolePermissions.filter(row => row.role_id === roleId).map(row => String(row.permission_code ?? '')) }) })),
    codeNamespaces: policyCodes.map(code => ({ code, namespace: derivePermissionNamespace(code) })),
  }
  const actor=users.find(row => row.id === actorId) ?? null
  const actorRoles=memberships.filter(row=>row.user_id===actorId).map(row=>String(row.role_id))
  let delegatedWitness: OperationSnapshot['delegatedWitness']=null
  if (actor && actor.role !== 'admin' && !actorRoles.includes('admin')) {
    const heldNamespaces = [...new Set(actorRoles.map(deriveDelegatedAdminNamespace).filter((value): value is string => Boolean(value)))].sort()
    const namespaces = excludeDisabledDelegationNamespaces(heldNamespaces, delegationActivations.filter(row => row.admin_user_id === actorId))
    const scopes=await bounded(query,'SELECT id::text AS id, namespace, directory_department_id::text AS directory_department_id, include_children FROM delegated_role_admin_scopes WHERE admin_user_id::text=$1 ORDER BY id::text LIMIT 1001',[actorId])
    const groups=await bounded(query,'SELECT id::text AS id, namespace, group_id::text AS group_id FROM delegated_role_admin_member_groups WHERE admin_user_id::text=$1 ORDER BY id::text LIMIT 1001',[actorId])
    const departments=await bounded(query, `WITH RECURSIVE relevant AS (
      SELECT d.id,d.integration_id,d.external_department_id,d.external_parent_department_id,d.is_active,COALESCE(s.include_children,TRUE) AS expand
      FROM delegated_role_admin_scopes s JOIN directory_departments d ON d.id=s.directory_department_id WHERE s.admin_user_id::text=$1
      UNION SELECT d.id,d.integration_id,d.external_department_id,d.external_parent_department_id,d.is_active,TRUE
      FROM directory_departments d JOIN relevant r ON d.integration_id=r.integration_id AND d.external_parent_department_id=r.external_department_id WHERE r.expand AND r.is_active
    ) SELECT id::text,integration_id::text,external_department_id,external_parent_department_id,is_active,expand FROM relevant ORDER BY id::text LIMIT 1001`,[actorId])
    const targetLinks=await bounded(query,`SELECT l.directory_account_id::text,l.link_status,a.is_active,ad.directory_department_id::text
      FROM directory_account_links l LEFT JOIN directory_accounts a ON a.id=l.directory_account_id
      LEFT JOIN directory_account_departments ad ON ad.directory_account_id=a.id WHERE l.local_user_id::text=$1
      ORDER BY l.directory_account_id::text,ad.directory_department_id::text LIMIT 1001`,[input.targetUserId])
    const targetGroups=await bounded(query,'SELECT group_id::text FROM platform_member_group_members WHERE user_id::text=$1 ORDER BY group_id::text LIMIT 1001',[input.targetUserId])
    const audience=[]
    for (const namespace of namespaces) audience.push({namespace,allowed:await isUserWithinDelegatedScope(actorId,[namespace],input.targetUserId,query)})
    delegatedWitness={namespaces,audience,scopes,groups,departments,targetLinks,targetGroups}
  }
  return { actor, target, memberships, roles, rolePermissions, requestedCodes, permissionCatalog, template, direct, admissions, departmentScopes, groupScopes, delegationActivations, delegationActivationEnabled: isDelegatedScopeActivationEnabled(), delegatedWitness, exactDepartment: process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED ?? null, policy }
}

function changingDelegationNamespace(roles: ReadonlySet<string>, action: AuthorizationOperationRequest['action']): string | null {
  if (!isRoleAction(action) || roles.has(action.roleId) === (action.kind === 'role.assign')) return null
  const namespace = deriveDelegatedAdminNamespace(action.roleId)
  return namespace && ![...roles].some(id => id !== action.roleId && deriveDelegatedAdminNamespace(id) === namespace) ? namespace : null
}

/** A managed lifetime stays disabled after its role ends, including with rollout switched off. */
export function expectedDelegationActivationReset(input: AuthorizationOperationRequest, snapshot: OperationSnapshot): string | null {
  const roles = new Set(snapshot.memberships.filter(row => row.user_id === input.targetUserId).map(row => String(row.role_id)))
  const namespace = changingDelegationNamespace(roles, input.action)
  if (namespace && (snapshot.delegationActivationEnabled || snapshot.delegationActivations.some(row => row.admin_user_id === input.targetUserId && row.namespace === namespace))) return namespace
  return null
}

/** Stable serialization sorts object keys as well as query result sets. */
export function canonicalOperationValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOperationValue).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalOperationValue(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
export function operationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalOperationValue(value)).digest('hex')
}
export function operationVersion(actorId: string, input: AuthorizationOperationRequest, snapshot: OperationSnapshot): string {
  return `opaque-v1:${operationDigest({ actorId, input, snapshot })}`
}

function codes(snapshot: OperationSnapshot, roleIds: Set<string>, admissions: Map<string, boolean>, rawAdmin: boolean): AuthorizationOperationPermission[] {
  const sourceMap = new Map<string, AuthorizationOperationPermission['sources']>()
  const add = (code: unknown, kind: 'role' | 'direct' | 'legacy' | 'profile', id: string | null) => {
    if (typeof code !== 'string' || !code.trim()) return
    const key = code.trim()
    const sources = sourceMap.get(key) ?? []
    if (!sources.some(source => source.kind === kind && source.id === id)) sources.push({ kind, id })
    sourceMap.set(key, sources)
  }
  if (roleIds.has('admin')) add('*:*', 'role', 'admin')
  if (rawAdmin) add('*:*', 'profile', null)
  for (const row of snapshot.rolePermissions) if (roleIds.has(String(row.role_id))) add(row.permission_code, 'role', String(row.role_id))
  for (const row of snapshot.direct) add(row.permission_code, 'direct', null)
  if (Array.isArray(snapshot.target?.permissions)) for (const code of snapshot.target.permissions) add(code, 'legacy', null)
  const namespaces = new Set<string>()
  for (const roleId of roleIds) {
    for (const namespace of deriveGrantNamespaces({ roleId, permissionCodes: snapshot.rolePermissions.filter(row => row.role_id === roleId).map(row => String(row.permission_code ?? '')) })) namespaces.add(namespace)
  }
  return [...sourceMap].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, sources]) => {
    const ns = derivePermissionNamespace(code)
    return { code, sources: sources.sort((a, b) => `${a.kind}:${a.id ?? ''}`.localeCompare(`${b.kind}:${b.id ?? ''}`)), effective: rawAdmin || roleIds.has('admin') || !ns || (namespaces.has(ns) && admissions.get(ns) === true) }
  })
}

/** Calculate from the same source sets that the existing admission and role writers use. */
export function calculateOperationImpact(input: AuthorizationOperationRequest, snapshot: OperationSnapshot): AuthorizationOperationImpact {
  const beforeRoles = new Set(snapshot.memberships.filter(row => row.user_id === input.targetUserId).map(row => String(row.role_id)))
  const afterRoles = new Set(beforeRoles)
  const beforeAdmissions = new Map(snapshot.admissions.map(row => [String(row.namespace), row.enabled === true]))
  const afterAdmissions = new Map(beforeAdmissions)
  const sourceChanges: AuthorizationOperationImpact['sourceChanges'] = []
  const derived: AuthorizationOperationImpact['admissionChanges'] = []
  const scopeCleanup: AuthorizationOperationImpact['scopeCleanup'] = []
  if (isRoleAction(input.action)) {
    const { roleId, kind } = input.action
    const held = beforeRoles.has(roleId)
    if (kind === 'role.assign') afterRoles.add(roleId); else afterRoles.delete(roleId)
    sourceChanges.push({ source: 'role', id: roleId, operation: kind === 'role.assign' ? 'assign' : 'revoke', changed: kind === 'role.assign' ? !held : held })
    const namespace = changingDelegationNamespace(beforeRoles, input.action)
    if (namespace) {
      for (const row of snapshot.departmentScopes.filter(row => row.namespace === namespace)) scopeCleanup.push({ namespace, kind: 'department', id: String(row.id) })
      for (const row of snapshot.groupScopes.filter(row => row.namespace === namespace)) scopeCleanup.push({ namespace, kind: 'member_group', id: String(row.id) })
    }
    if (kind === 'role.revoke') {
      const roleCodes = snapshot.rolePermissions.filter(row => row.role_id === roleId).map(row => String(row.permission_code ?? ''))
      const affected = new Set(deriveGrantNamespaces({ roleId, permissionCodes: roleCodes }))
      if (roleId === 'attendance_employee') affected.add('attendance')
      for (const ns of [...affected].sort()) {
        const hasRole = [...afterRoles].some(id => roleIdMatchesNamespace(id, ns) || snapshot.rolePermissions.some(row => row.role_id === id && String(row.permission_code ?? '').startsWith(`${ns}:`)))
        const optOut = roleId === 'attendance_employee' && ns === 'attendance'
        if (hasRole && !optOut) continue
        const before = beforeAdmissions.has(ns) ? beforeAdmissions.get(ns)! : null
        const after = hasRole && before !== null ? before : false
        afterAdmissions.set(ns, after)
        derived.push({ namespace: ns, before, after, cause: 'role_revoke' })
      }
    }
  }
  let afterSnapshot=snapshot
  if (input.action.kind==='direct.grant' || input.action.kind==='direct.revoke' || input.action.kind==='template.apply') {
    const directCodes=new Set(snapshot.direct.map(row=>String(row.permission_code)))
    for (const code of snapshot.requestedCodes) {
      const held=directCodes.has(code), revoke=input.action.kind==='direct.revoke'
      sourceChanges.push({source:'direct',id:code,operation:revoke?'revoke':'assign',changed:revoke ? held : !held})
      if(revoke) directCodes.delete(code); else directCodes.add(code)
    }
    afterSnapshot={...snapshot,direct:[...directCodes].sort().map(permission_code=>({permission_code}))}
  } else if (input.action.kind==='legacy.revoke') {
    const removed=removeMatchingLegacyPermission(snapshot.target?.permissions,input.action.code)
    sourceChanges.push({source:'legacy',id:input.action.code,operation:'revoke',changed:removed.changed})
    afterSnapshot={...snapshot,target:snapshot.target ? {...snapshot.target,permissions:removed.next} : null}
  }
  for (const change of input.admissionChanges) {
    if (derived.some(item => item.namespace === change.namespace)) throw new OperationAdmissionConflict()
    const before = beforeAdmissions.has(change.namespace) ? beforeAdmissions.get(change.namespace)! : null
    afterAdmissions.set(change.namespace, change.enabled)
    derived.push({ namespace: change.namespace, before, after: change.enabled, cause: 'explicit' })
  }
  const beforeRawAdmin = snapshot.target?.role === 'admin'
  const afterRawAdmin = isRoleAction(input.action) && input.action.roleId === 'admin'
    ? input.action.kind === 'role.assign' : beforeRawAdmin
  const effectiveBefore = codes(snapshot, beforeRoles, beforeAdmissions, beforeRawAdmin)
  const effectiveAfter = codes(afterSnapshot, afterRoles, afterAdmissions, afterRawAdmin)
  const roleId = isRoleAction(input.action) ? input.action.roleId : null
  const retainedOtherGrants = roleId ? effectiveAfter.filter(entry => entry.sources.some(source => source.kind !== 'role' || source.id !== roleId)) : input.action.kind==='admission.set' ? [] : effectiveAfter.filter(entry=>snapshot.requestedCodes.includes(entry.code) && entry.sources.some(source=>source.kind !== (input.action.kind==='legacy.revoke' ? 'legacy' : 'direct')))
  const warnings: string[]=[]
  if(input.action.kind === 'role.revoke' && input.action.roleId === 'attendance_employee') warnings.push('attendance_employee_opt_out')
  if(effectiveBefore.some(entry=>entry.code.includes('*')) || effectiveAfter.some(entry=>entry.code.includes('*'))) warnings.push('effective_permissions_do_not_expand_wildcards')
  if(beforeRawAdmin || afterRawAdmin) warnings.push('effective_permissions_include_platform_admin_profile')
  return { sourceChanges, admissionChanges: derived.sort((a, b) => a.namespace.localeCompare(b.namespace)), scopeCleanup, effectiveBefore, effectiveAfter, retainedOtherGrants, warnings }
}
