/**
 * Pure request and response checks for admin authorization operations.
 * A body that is missing a required field, or has the wrong shape, is not a success.
 * Effective permissions keep the boolean from the response.
 * An action accepts only the fields for its own kind.
 */

export const ADMIN_AUTHORIZATION_OPERATIONS_PATH = '/api/admin/authorization-operations'
export const ADMIN_AUTHORIZATION_PREVIEW_PATH = '/api/admin/authorization-operations/preview'
export const ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION = 1
export const ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY = 'metasheet.adminAuthorizationOperation.pending.v1'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const IMPACT_KEYS = [
  'sourceChanges',
  'admissionChanges',
  'scopeCleanup',
  'effectiveBefore',
  'effectiveAfter',
  'retainedOtherGrants',
  'warnings',
] as const

export type AdminAuthorizationImpactKey = (typeof IMPACT_KEYS)[number]

/** Role source id is the role id. Profile, direct, and legacy sources have no id. */
export type AdminAuthorizationEffectiveSource =
  | { kind: 'role'; id: string }
  | { kind: 'profile'; id: null }
  | { kind: 'direct'; id: null }
  | { kind: 'legacy'; id: null }

export interface AdminAuthorizationEffectivePermission {
  code: string
  sources: AdminAuthorizationEffectiveSource[]
  effective: boolean
}

export interface AdminAuthorizationSourceChange {
  source: 'role' | 'direct' | 'legacy'
  id: string
  operation: 'assign' | 'revoke'
  changed: boolean
}

/** Impact admission diff. The request still sends `{ namespace, enabled }`. */
export interface AdminAuthorizationImpactAdmissionChange {
  namespace: string
  before: boolean | null
  after: boolean
  cause: 'explicit' | 'role_revoke'
}

export interface AdminAuthorizationScopeCleanup {
  namespace: string
  kind: 'department' | 'member_group'
  id: string
}

export interface AdminAuthorizationImpact {
  sourceChanges: AdminAuthorizationSourceChange[]
  admissionChanges: AdminAuthorizationImpactAdmissionChange[]
  scopeCleanup: AdminAuthorizationScopeCleanup[]
  effectiveBefore: AdminAuthorizationEffectivePermission[]
  effectiveAfter: AdminAuthorizationEffectivePermission[]
  retainedOtherGrants: AdminAuthorizationEffectivePermission[]
  warnings: string[]
}

export interface AdminAuthorizationRoleAction {
  kind: 'role.assign' | 'role.revoke'
  roleId: string
}

export interface AdminAuthorizationAdmissionAction {
  kind: 'admission.set'
}

export interface AdminAuthorizationDirectLegacyAction {
  kind: 'direct.grant' | 'direct.revoke' | 'legacy.revoke'
  code: string
}

export interface AdminAuthorizationTemplateAction {
  kind: 'template.apply'
  templateId: string
}

export type AdminAuthorizationAction =
  | AdminAuthorizationRoleAction
  | AdminAuthorizationAdmissionAction
  | AdminAuthorizationDirectLegacyAction
  | AdminAuthorizationTemplateAction

export interface AdminAuthorizationAdmissionChange {
  namespace: string
  enabled: boolean
}

export interface AdminAuthorizationRequest {
  targetUserId: string
  action: AdminAuthorizationAction
  admissionChanges: AdminAuthorizationAdmissionChange[]
  reason?: string
}

export interface AdminAuthorizationPreview {
  expectedVersion: string
  impact: AdminAuthorizationImpact
}

export interface AdminAuthorizationReceipt {
  targetUserId: string
  action: AdminAuthorizationAction
  impact: AdminAuthorizationImpact
  resultVersion: string
}

export interface AdminAuthorizationCommitted {
  status: 'committed'
  clientOperationId: string
  receipt: AdminAuthorizationReceipt
}

export interface AdminAuthorizationUnknown {
  status: 'unknown_or_pending'
  clientOperationId: string
}

export type AdminAuthorizationLookup = AdminAuthorizationCommitted | AdminAuthorizationUnknown

export interface AdminAuthorizationPendingEntry {
  principalId: string
  targetId: string
  clientOperationId: string
}

export interface AdminAuthorizationPendingFile {
  formatVersion: typeof ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION
  entries: AdminAuthorizationPendingEntry[]
}

export type AdminAuthorizationTransportMethod = 'GET' | 'POST'

export interface AdminAuthorizationTransportRequest {
  path: string
  method: AdminAuthorizationTransportMethod
  body?: unknown
  signal?: AbortSignal
}

export interface AdminAuthorizationTransportResponse {
  status: number
  body?: unknown
}

export type AdminAuthorizationTransport = (
  request: AdminAuthorizationTransportRequest,
) => Promise<AdminAuthorizationTransportResponse>

export function adminAuthorizationOperationLookupPath(clientOperationId: string): string {
  return `${ADMIN_AUTHORIZATION_OPERATIONS_PATH}/${clientOperationId}`
}

export function isAdminAuthorizationOperationUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  if (keys.length !== allowed.length) return false
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
  }
  return true
}

function readEffectiveSource(value: unknown): AdminAuthorizationEffectiveSource | null {
  if (!isRecord(value) || !sameKeys(value, ['kind', 'id'])) return null
  if (value.kind === 'profile' || value.kind === 'direct' || value.kind === 'legacy') {
    if (value.id !== null) return null
    return { kind: value.kind, id: null }
  }
  if (value.kind === 'role') {
    if (!nonEmptyString(value.id)) return null
    return { kind: 'role', id: value.id }
  }
  return null
}

function readEffectivePermission(value: unknown): AdminAuthorizationEffectivePermission | null {
  if (!isRecord(value) || !sameKeys(value, ['code', 'sources', 'effective'])) return null
  if (!nonEmptyString(value.code) || !Array.isArray(value.sources) || typeof value.effective !== 'boolean') return null
  const sources: AdminAuthorizationEffectiveSource[] = []
  for (const source of value.sources) {
    const read = readEffectiveSource(source)
    if (!read) return null
    sources.push(read)
  }
  return { code: value.code, sources, effective: value.effective }
}

function readEffectivePermissionList(value: unknown): AdminAuthorizationEffectivePermission[] | null {
  if (!Array.isArray(value)) return null
  const permissions: AdminAuthorizationEffectivePermission[] = []
  for (const item of value) {
    const read = readEffectivePermission(item)
    if (!read) return null
    permissions.push(read)
  }
  return permissions
}

function readItemList<T>(value: unknown, readItem: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const items: T[] = []
  for (const item of value) {
    const read = readItem(item)
    if (read === null) return null
    items.push(read)
  }
  return items
}

function readSourceChange(value: unknown): AdminAuthorizationSourceChange | null {
  if (!isRecord(value) || !sameKeys(value, ['source', 'id', 'operation', 'changed'])) return null
  if (value.source !== 'role' && value.source !== 'direct' && value.source !== 'legacy') return null
  if (!nonEmptyString(value.id)) return null
  if (value.operation !== 'assign' && value.operation !== 'revoke') return null
  if (typeof value.changed !== 'boolean') return null
  return { source: value.source, id: value.id, operation: value.operation, changed: value.changed }
}

function readImpactAdmissionChange(value: unknown): AdminAuthorizationImpactAdmissionChange | null {
  if (!isRecord(value) || !sameKeys(value, ['namespace', 'before', 'after', 'cause'])) return null
  if (!nonEmptyString(value.namespace)) return null
  if (value.before !== null && typeof value.before !== 'boolean') return null
  if (typeof value.after !== 'boolean') return null
  if (value.cause !== 'explicit' && value.cause !== 'role_revoke') return null
  return {
    namespace: value.namespace,
    before: value.before,
    after: value.after,
    cause: value.cause,
  }
}

function readScopeCleanup(value: unknown): AdminAuthorizationScopeCleanup | null {
  if (!isRecord(value) || !sameKeys(value, ['namespace', 'kind', 'id'])) return null
  if (!nonEmptyString(value.namespace) || !nonEmptyString(value.id)) return null
  if (value.kind !== 'department' && value.kind !== 'member_group') return null
  return { namespace: value.namespace, kind: value.kind, id: value.id }
}

function readWarning(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function readAdminAuthorizationImpact(value: unknown): AdminAuthorizationImpact | null {
  if (!isRecord(value)) return null
  for (const key of IMPACT_KEYS) {
    if (!Array.isArray(value[key])) return null
  }
  const sourceChanges = readItemList(value.sourceChanges, readSourceChange)
  const admissionChanges = readItemList(value.admissionChanges, readImpactAdmissionChange)
  const scopeCleanup = readItemList(value.scopeCleanup, readScopeCleanup)
  const effectiveBefore = readEffectivePermissionList(value.effectiveBefore)
  const effectiveAfter = readEffectivePermissionList(value.effectiveAfter)
  const retainedOtherGrants = readEffectivePermissionList(value.retainedOtherGrants)
  const warnings = readItemList(value.warnings, readWarning)
  if (
    !sourceChanges
    || !admissionChanges
    || !scopeCleanup
    || !effectiveBefore
    || !effectiveAfter
    || !retainedOtherGrants
    || !warnings
  ) return null
  return {
    sourceChanges,
    admissionChanges,
    scopeCleanup,
    effectiveBefore,
    effectiveAfter,
    retainedOtherGrants,
    warnings,
  }
}

export function readAdminAuthorizationAction(value: unknown): AdminAuthorizationAction | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'admission.set') {
    if (!sameKeys(value, ['kind'])) return null
    return { kind: 'admission.set' }
  }
  if (value.kind === 'role.assign' || value.kind === 'role.revoke') {
    if (!sameKeys(value, ['kind', 'roleId']) || !nonEmptyString(value.roleId)) return null
    return { kind: value.kind, roleId: value.roleId }
  }
  if (value.kind === 'direct.grant' || value.kind === 'direct.revoke' || value.kind === 'legacy.revoke') {
    if (!sameKeys(value, ['kind', 'code']) || !nonEmptyString(value.code)) return null
    return { kind: value.kind, code: value.code }
  }
  if (value.kind === 'template.apply') {
    if (!sameKeys(value, ['kind', 'templateId']) || !nonEmptyString(value.templateId)) return null
    return { kind: 'template.apply', templateId: value.templateId }
  }
  return null
}

export function readAdminAuthorizationRequest(value: unknown): AdminAuthorizationRequest | null {
  if (!isRecord(value)) return null
  if (!nonEmptyString(value.targetUserId)) return null
  const action = readAdminAuthorizationAction(value.action)
  if (!action) return null
  if (!Array.isArray(value.admissionChanges)) return null
  const admissionChanges: AdminAuthorizationAdmissionChange[] = []
  for (const change of value.admissionChanges) {
    if (!isRecord(change) || !nonEmptyString(change.namespace) || typeof change.enabled !== 'boolean') return null
    admissionChanges.push({ namespace: change.namespace, enabled: change.enabled })
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  return {
    targetUserId: value.targetUserId,
    action,
    admissionChanges,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  }
}

export function readAdminAuthorizationPreview(value: unknown): AdminAuthorizationPreview | null {
  if (!isRecord(value) || !nonEmptyString(value.expectedVersion)) return null
  const impact = readAdminAuthorizationImpact(value.impact)
  if (!impact) return null
  return { expectedVersion: value.expectedVersion, impact }
}

export function readAdminAuthorizationReceipt(value: unknown): AdminAuthorizationReceipt | null {
  if (!isRecord(value) || !nonEmptyString(value.targetUserId) || !nonEmptyString(value.resultVersion)) return null
  const action = readAdminAuthorizationAction(value.action)
  const impact = readAdminAuthorizationImpact(value.impact)
  if (!action || !impact) return null
  return {
    targetUserId: value.targetUserId,
    action,
    impact,
    resultVersion: value.resultVersion,
  }
}

export function readAdminAuthorizationLookup(value: unknown): AdminAuthorizationLookup | null {
  if (!isRecord(value) || !isAdminAuthorizationOperationUuid(value.clientOperationId)) return null
  if (value.status === 'unknown_or_pending') {
    return { status: 'unknown_or_pending', clientOperationId: value.clientOperationId }
  }
  if (value.status !== 'committed') return null
  const receipt = readAdminAuthorizationReceipt(value.receipt)
  if (!receipt) return null
  return { status: 'committed', clientOperationId: value.clientOperationId, receipt }
}

function readPendingEntry(value: unknown): AdminAuthorizationPendingEntry | null {
  if (!isRecord(value)) return null
  if (!nonEmptyString(value.principalId) || !nonEmptyString(value.targetId)) return null
  if (!isAdminAuthorizationOperationUuid(value.clientOperationId)) return null
  return {
    principalId: value.principalId,
    targetId: value.targetId,
    clientOperationId: value.clientOperationId,
  }
}

export function readAdminAuthorizationPendingFile(value: unknown): AdminAuthorizationPendingFile | null {
  if (!isRecord(value) || value.formatVersion !== ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION) return null
  if (!Array.isArray(value.entries)) return null
  const entries: AdminAuthorizationPendingEntry[] = []
  for (const entry of value.entries) {
    const pending = readPendingEntry(entry)
    if (!pending) return null
    entries.push(pending)
  }
  return { formatVersion: ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION, entries }
}

export function serializeAdminAuthorizationPendingFile(file: AdminAuthorizationPendingFile): string {
  return JSON.stringify({
    formatVersion: ADMIN_AUTHORIZATION_PENDING_FORMAT_VERSION,
    entries: file.entries.map((entry) => ({
      principalId: entry.principalId,
      targetId: entry.targetId,
      clientOperationId: entry.clientOperationId,
    })),
  })
}
