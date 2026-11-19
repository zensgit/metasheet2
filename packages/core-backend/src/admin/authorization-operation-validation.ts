import { isNamespaceAdmissionControlledResource } from '../rbac/namespace-admission'
import type { AuthorizationOperationAction, AuthorizationOperationCommitRequest, AuthorizationOperationRequest } from './authorization-operation-contract'

export class AuthorizationOperationInvalid extends Error {
  readonly status = 400
  readonly code: string
  constructor(code = 'INVALID_AUTHORIZATION_OPERATION') { super('Invalid authorization operation'); this.code = code }
}

const fail = (): never => { throw new AuthorizationOperationInvalid() }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function shape(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return fail()
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.trim()) return fail()
  return value
}
function action(value: unknown): AuthorizationOperationAction {
  const input = shape(value, ['kind', 'roleId', 'code', 'templateId'])
  if (input.kind === 'admission.set') {
    if (Object.keys(input).some(key=>key!=='kind')) return fail()
    return { kind: 'admission.set' }
  }
  if (input.kind === 'direct.grant' || input.kind === 'direct.revoke' || input.kind === 'legacy.revoke') {
    if (Object.keys(input).some(key=>key!=='kind' && key!=='code')) return fail()
    return {kind:input.kind,code:id(input.code)}
  }
  if (input.kind === 'template.apply') {
    if (Object.keys(input).some(key=>key!=='kind' && key!=='templateId')) return fail()
    return {kind:'template.apply',templateId:id(input.templateId)}
  }
  if (input.kind !== 'role.assign' && input.kind !== 'role.revoke') return fail()
  if (Object.keys(input).some(key=>key!=='kind' && key!=='roleId')) return fail()
  return { kind: input.kind, roleId: id(input.roleId) }
}

export function parseClientOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return fail()
  return value
}

/** Validate and canonicalize the request without inferring namespace selections. */
export function parseAuthorizationOperation(value: unknown, commit: false): AuthorizationOperationRequest
export function parseAuthorizationOperation(value: unknown, commit: true): AuthorizationOperationCommitRequest
export function parseAuthorizationOperation(value: unknown, commit: boolean): AuthorizationOperationRequest | AuthorizationOperationCommitRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 32768) throw new AuthorizationOperationInvalid('AUTHORIZATION_OPERATION_TOO_LARGE')
  const input = shape(value, commit
    ? ['targetUserId', 'action', 'admissionChanges', 'reason', 'clientOperationId', 'expectedVersion']
    : ['targetUserId', 'action', 'admissionChanges', 'reason'])
  const operationAction = action(input.action)
  if (!Array.isArray(input.admissionChanges) || input.admissionChanges.length > 20) return fail()
  const seen = new Set<string>()
  const admissionChanges = input.admissionChanges.map((item) => {
    const change = shape(item, ['namespace', 'enabled'])
    const namespace = id(change.namespace)
    if (!isNamespaceAdmissionControlledResource(namespace) || seen.has(namespace) || typeof change.enabled !== 'boolean') return fail()
    seen.add(namespace)
    return { namespace, enabled: change.enabled }
  }).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)
  if (operationAction.kind === 'admission.set' && admissionChanges.length === 0) return fail()
  let reason: string | undefined
  if (input.reason !== undefined) {
    if (typeof input.reason !== 'string') return fail()
    reason = input.reason.trim()
    if (Array.from(reason).length < 1 || Array.from(reason).length > 255) return fail()
  }
  if ((operationAction.kind==='direct.grant' || operationAction.kind==='template.apply') && reason===undefined) throw new AuthorizationOperationInvalid('REASON_REQUIRED')
  const normalized: AuthorizationOperationRequest = {
    targetUserId: id(input.targetUserId), action: operationAction, admissionChanges,
    ...(reason === undefined ? {} : { reason }),
  }
  if (!commit) return normalized
  const clientOperationId = parseClientOperationId(input.clientOperationId)
  if (typeof input.expectedVersion !== 'string' || !/^opaque-v1:[0-9a-f]{64}$/.test(input.expectedVersion)) return fail()
  return { ...normalized, clientOperationId, expectedVersion: input.expectedVersion }
}
