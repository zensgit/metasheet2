import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'

export interface YidaOwnerDraftInput {
  readonly config: unknown
  readonly rowsText: string
  readonly allocation: unknown
}
export interface YidaOwnerDraft {
  readonly targetRef: string
  readonly operationId: string
  readonly status: 'unverified'
  readonly identityKind: 'local-unverified'
  readonly canSend: false
  readonly canApply: false
  readonly tokenIssued: false
  readonly externalWriteAttempted: false
  readonly rowCount: number
  readonly rows: readonly Readonly<{ rowKey: string; index: number }>[]
  readonly reused: boolean
}
export interface YidaOwnerSelection {
  readonly operationId: string
  readonly rowKey: string
}
export interface YidaOwnerPreview extends YidaOwnerSelection {
  readonly planDigest: string
  readonly rowPayloadDigest: string
  readonly target: Readonly<{
    targetRef: string
    identityKind: 'owner-attested-single-target'
    evidenceVersion: 1
    reviewRef: string
    organizationId: string
    appType: string
    formUuid: string
  }>
  readonly payload: Readonly<Record<string, string | number | boolean>>
  readonly policy: Readonly<{
    intent: 'create'
    maxAttempts: 1
    maxTtlMs: 900000
    requiresExplicitConfirmation: true
    unknownMustNotRetry: true
  }>
  readonly canSend: false
  readonly externalWriteAttempted: false
}
export interface YidaOwnerApprovalInput extends YidaOwnerSelection {
  readonly confirmationId: string
  readonly acknowledgeOnce: true
  readonly ttlMs?: number
}
export interface YidaOwnerApproval {
  readonly grantId: string
  readonly operationId: string
  readonly rowKey: string
  readonly targetRef: string
  readonly approvedAt: number
  readonly expiresAt: number
  readonly maxAttempts: 1
  readonly remainingAttempts: 0 | 1
  readonly status: 'approved' | 'expired' | 'revoked' | 'admitted'
  readonly revoked: boolean
  readonly admissionId: string | null
  readonly ledgerId: string | null
  readonly canSend: false
  readonly externalWriteAttempted: false
}
export type YidaOwnerDeliveryStatus = 'prepared' | 'dispatching' | 'acknowledged' | 'outcome_unknown' | 'not_sent'
export interface YidaOwnerObservation {
  readonly approval: YidaOwnerApproval
  readonly delivery: Readonly<{ id: string; status: YidaOwnerDeliveryStatus; durable: true }> | null
}
export interface YidaOwnerSubmissionInput {
  readonly grantId: string
  readonly submissionId: string
}
export interface YidaOwnerSubmission extends YidaOwnerObservation {
  readonly reused: boolean
  readonly status: YidaOwnerDeliveryStatus | 'state_unconfirmed' | 'not_started'
  readonly externalWriteAttempted: boolean
  readonly businessVerified: false
  readonly durable: boolean
}
export type YidaOwnerApprovalResult = YidaOwnerApproval & Readonly<{ reused: boolean }>

const prefix = '/api/integration/yida-owner-send'
const maximumBodyBytes = 1024 * 1024
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const deliveryStates: readonly YidaOwnerDeliveryStatus[] = ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent']
const errorStatuses: Readonly<Record<string, readonly number[]>> = Object.freeze({
  UNAUTHORIZED: [401], NOT_FOUND: [404],
  YIDA_OWNER_HTTP_INPUT: [400, 413, 415], YIDA_OWNER_HTTP_DENIED: [403], YIDA_OWNER_HTTP_UNAVAILABLE: [503],
  YIDA_OWNER_RUNTIME_INPUT: [400], YIDA_OWNER_RUNTIME_DISABLED: [403], YIDA_OWNER_RUNTIME_INACTIVE: [503],
  YIDA_OWNER_RUNTIME_UNAVAILABLE: [503], YIDA_OWNER_RUNTIME_CANCELLED: [409],
  YIDA_SEND_APPROVAL_INPUT: [400], YIDA_SEND_APPROVAL_NOT_FOUND: [404], YIDA_SEND_APPROVAL_CONFLICT: [409],
  YIDA_SEND_APPROVAL_EXPIRED: [409], YIDA_SEND_APPROVAL_REVOKED: [409], YIDA_SEND_APPROVAL_CANCELLED: [409],
  YIDA_SEND_APPROVAL_UNAVAILABLE: [503],
})
export class YidaOwnerClientError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'YidaOwnerClientError'; this.code = code }
}
type Row = Record<string, unknown>
function invalid(): never { throw new YidaOwnerClientError('YIDA_OWNER_RESPONSE_INVALID') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Row
  const keys = Object.keys(row)
  if (required.some(key => !Object.prototype.hasOwnProperty.call(row, key)) || keys.some(key => ![...required, ...optional].includes(key))) invalid()
  return row
}
function canonical(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid()
  return value
}
function uuid(value: unknown): string { const result = canonical(value); if (!uuidPattern.test(result)) invalid(); return result }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(); return value }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid()
  return value as number
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value }
function checkedInput<T>(parse: () => T): T { try { return parse() } catch { throw new YidaOwnerClientError('YIDA_OWNER_INPUT_INVALID') } }
function selection(value: unknown): YidaOwnerSelection {
  const row = object(value, ['operationId', 'rowKey'])
  return Object.freeze({ operationId: uuid(row.operationId), rowKey: uuid(row.rowKey) })
}
function draft(value: unknown): YidaOwnerDraft {
  const row = object(value, ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply', 'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'])
  if (row.status !== 'unverified' || row.identityKind !== 'local-unverified' || row.canSend !== false || row.canApply !== false
    || row.tokenIssued !== false || row.externalWriteAttempted !== false || !Array.isArray(row.rows)
    || row.rows.length < 1 || row.rows.length > 100 || row.rowCount !== row.rows.length) invalid()
  const rows = row.rows.map((value, index) => {
    const member = object(value, ['rowKey', 'index'])
    if (member.index !== index) invalid()
    return Object.freeze({ rowKey: uuid(member.rowKey), index })
  })
  if (new Set(rows.map(member => member.rowKey)).size !== rows.length) invalid()
  return Object.freeze({ targetRef: uuid(row.targetRef), operationId: uuid(row.operationId), status: 'unverified', identityKind: 'local-unverified',
    canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: rows.length,
    rows: Object.freeze(rows), reused: boolean(row.reused) })
}
function preview(value: unknown, selected: YidaOwnerSelection): YidaOwnerPreview {
  const row = object(value, ['operationId', 'rowKey', 'planDigest', 'rowPayloadDigest', 'target', 'payload', 'policy', 'canSend', 'externalWriteAttempted'])
  const target = object(row.target, ['targetRef', 'identityKind', 'evidenceVersion', 'reviewRef', 'organizationId', 'appType', 'formUuid'])
  const policy = object(row.policy, ['intent', 'maxAttempts', 'maxTtlMs', 'requiresExplicitConfirmation', 'unknownMustNotRetry'])
  if (uuid(row.operationId) !== selected.operationId || uuid(row.rowKey) !== selected.rowKey
    || target.identityKind !== 'owner-attested-single-target' || target.evidenceVersion !== 1
    || policy.intent !== 'create' || policy.maxAttempts !== 1 || policy.maxTtlMs !== 900000
    || policy.requiresExplicitConfirmation !== true || policy.unknownMustNotRetry !== true
    || row.canSend !== false || row.externalWriteAttempted !== false) invalid()
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) invalid()
  const fields = Object.entries(row.payload)
  if (!fields.length || fields.length > 100) invalid()
  const payload: Record<string, string | number | boolean> = Object.create(null)
  for (const [key, value] of fields) {
    canonical(key)
    if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) invalid()
    payload[key] = value
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 256 * 1024) invalid()
  return Object.freeze({ ...selected, planDigest: digest(row.planDigest), rowPayloadDigest: digest(row.rowPayloadDigest),
    target: Object.freeze({ targetRef: uuid(target.targetRef), identityKind: 'owner-attested-single-target', evidenceVersion: 1,
      reviewRef: canonical(target.reviewRef), organizationId: canonical(target.organizationId), appType: canonical(target.appType), formUuid: canonical(target.formUuid) }),
    payload: Object.freeze(payload), policy: Object.freeze({ intent: 'create', maxAttempts: 1, maxTtlMs: 900000, requiresExplicitConfirmation: true, unknownMustNotRetry: true }),
    canSend: false, externalWriteAttempted: false })
}
const approvalKeys = ['grantId', 'operationId', 'rowKey', 'targetRef', 'approvedAt', 'expiresAt', 'maxAttempts', 'remainingAttempts', 'status', 'revoked', 'admissionId', 'ledgerId', 'canSend', 'externalWriteAttempted'] as const
function approval(value: unknown): YidaOwnerApproval {
  const row = object(value, approvalKeys)
  const approvedAt = integer(row.approvedAt, 1, Number.MAX_SAFE_INTEGER)
  const expiresAt = integer(row.expiresAt, approvedAt + 1, Math.min(Number.MAX_SAFE_INTEGER, approvedAt + 900000))
  if (row.maxAttempts !== 1 || (row.remainingAttempts !== 0 && row.remainingAttempts !== 1)
    || !['approved', 'expired', 'revoked', 'admitted'].includes(String(row.status)) || typeof row.status !== 'string'
    || row.canSend !== false || row.externalWriteAttempted !== false || (row.admissionId === null) !== (row.ledgerId === null)
    || (row.status === 'admitted') !== (row.admissionId !== null) || (row.status !== 'approved' && row.remainingAttempts !== 0)) invalid()
  return Object.freeze({ grantId: uuid(row.grantId), operationId: uuid(row.operationId), rowKey: uuid(row.rowKey), targetRef: uuid(row.targetRef),
    approvedAt, expiresAt, maxAttempts: 1, remainingAttempts: row.remainingAttempts, status: row.status as YidaOwnerApproval['status'],
    revoked: boolean(row.revoked), admissionId: row.admissionId === null ? null : uuid(row.admissionId), ledgerId: row.ledgerId === null ? null : uuid(row.ledgerId),
    canSend: false, externalWriteAttempted: false })
}
function approvalResult(value: unknown): YidaOwnerApprovalResult {
  const row = object(value, [...approvalKeys, 'reused'])
  const { reused, ...metadata } = row
  return Object.freeze({ ...approval(metadata), reused: boolean(reused) })
}
function observation(value: unknown, grantId: string): YidaOwnerObservation {
  const row = object(value, ['approval', 'delivery']), metadata = approval(row.approval)
  if (metadata.grantId !== grantId) invalid()
  let delivery: YidaOwnerObservation['delivery'] = null
  if (row.delivery !== null) {
    const item = object(row.delivery, ['id', 'status', 'durable'])
    if (item.durable !== true || !deliveryStates.includes(item.status as YidaOwnerDeliveryStatus)) invalid()
    delivery = Object.freeze({ id: uuid(item.id), status: item.status as YidaOwnerDeliveryStatus, durable: true })
  }
  if ((metadata.ledgerId === null) !== (delivery === null) || (delivery && delivery.id !== metadata.ledgerId)) invalid()
  return Object.freeze({ approval: metadata, delivery })
}
function submission(value: unknown, grantId: string): YidaOwnerSubmission {
  const row = object(value, ['approval', 'delivery', 'reused', 'status', 'externalWriteAttempted', 'businessVerified', 'durable'])
  if (![...deliveryStates, 'state_unconfirmed', 'not_started'].includes(String(row.status)) || typeof row.status !== 'string'
    || row.businessVerified !== false || (row.reused === true && row.externalWriteAttempted !== false)) invalid()
  return Object.freeze({ ...observation({ approval: row.approval, delivery: row.delivery }, grantId), reused: boolean(row.reused),
    status: row.status as YidaOwnerSubmission['status'], externalWriteAttempted: boolean(row.externalWriteAttempted), businessVerified: false, durable: boolean(row.durable) })
}

/** Captured session only. All actions are explicit; no retries, cookies, scope
 * headers, external origins, logs or persisted payload/command keys. Disposing
 * also rejects late responses even if the transport ignores AbortSignal. */
export function createYidaOwnerClient(options: { onInvalidated?: () => void } = {}) {
  const token = readStoredToken(), signature = readAuthSessionSignature()
  if (!token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    || signature === 'invalid' || token !== readStoredToken()) throw new YidaOwnerClientError('UNAUTHORIZED')
  const scopeHint = () => { try { return JSON.stringify([localStorage.getItem('tenantId'), localStorage.getItem('workspaceId')]) } catch { return 'invalid' } }
  const startedScope = scopeHint()
  let disposed = false
  const controllers = new Set<AbortController>()
  let unsubscribe = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', checkSession)
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  const invalidate = () => { if (disposed) return; dispose(); options.onInvalidated?.() }
  const checkSession = () => {
    if (readAuthSessionSignature() !== signature || readStoredToken() !== token || scopeHint() !== startedScope) invalidate()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || event.key === 'tenantId' || event.key === 'workspaceId'
      || TOKEN_KEYS.some(key => key === event.key)) invalidate()
  }
  unsubscribe = onAuthPrincipalChange(invalidate)
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', checkSession)
  const assertSession = () => { checkSession(); if (disposed) throw new YidaOwnerClientError('YIDA_OWNER_SESSION_CHANGED') }
  async function request<T>(path: string, method: 'GET' | 'POST', status: number, parse: (value: unknown) => T, body?: unknown, signal?: AbortSignal): Promise<T> {
    assertSession()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    controllers.add(controller)
    const timeout = setTimeout(abort, 15000)
    const current = () => { assertSession(); if (controller.signal.aborted) throw new YidaOwnerClientError('YIDA_OWNER_CANCELLED') }
    try {
      current()
      let response: Response
      try {
        response = await fetch(`${prefix}${path}`, { method, credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch { current(); throw new YidaOwnerClientError('YIDA_OWNER_UNAVAILABLE') }
      current()
      if (response.status === 401) { invalidate(); throw new YidaOwnerClientError('UNAUTHORIZED') }
      let envelope: Row
      try {
        const contentType = response.headers.get('content-type'), length = response.headers.get('content-length')
        if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)
          || (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximumBodyBytes)) || !response.body) invalid()
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0, text = ''
        try {
          for (;;) {
            const chunk = await reader.read()
            current()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maximumBodyBytes) invalid()
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
        } finally { reader.releaseLock() }
        envelope = object(JSON.parse(text), response.ok ? ['ok', 'data'] : ['ok', 'error'])
        if (envelope.ok !== response.ok) invalid()
      } catch { current(); controller.abort(); throw new YidaOwnerClientError('YIDA_OWNER_RESPONSE_INVALID') }
      if (!response.ok) {
        const error = object(envelope.error, ['code'])
        if (typeof error.code !== 'string' || !Object.prototype.hasOwnProperty.call(errorStatuses, error.code) || !errorStatuses[error.code].includes(response.status)) invalid()
        if (error.code === 'YIDA_OWNER_HTTP_DENIED') invalidate()
        throw new YidaOwnerClientError(error.code)
      }
      if (response.status !== status) invalid()
      const result = parse(envelope.data)
      current()
      return result
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controllers.delete(controller) }
  }
  return {
    dispose,
    prepareDraft(input: YidaOwnerDraftInput, signal?: AbortSignal): Promise<YidaOwnerDraft> {
      const body = checkedInput(() => {
        const row = object(input, ['config', 'rowsText', 'allocation'])
        if (typeof row.rowsText !== 'string' || new TextEncoder().encode(row.rowsText).length > 128 * 1024) invalid()
        return JSON.parse(JSON.stringify(row)) as YidaOwnerDraftInput
      })
      return request('/drafts', 'POST', 201, draft, body, signal)
    },
    preview(input: YidaOwnerSelection, signal?: AbortSignal): Promise<YidaOwnerPreview> {
      const body = checkedInput(() => selection(input))
      return request('/preview', 'POST', 200, value => preview(value, body), body, signal)
    },
    approve(input: YidaOwnerApprovalInput, signal?: AbortSignal): Promise<YidaOwnerApprovalResult> {
      const body = checkedInput(() => {
        const row = object(input, ['operationId', 'rowKey', 'confirmationId', 'acknowledgeOnce'], ['ttlMs'])
        if (row.acknowledgeOnce !== true) invalid()
        return { operationId: uuid(row.operationId), rowKey: uuid(row.rowKey), confirmationId: uuid(row.confirmationId), acknowledgeOnce: true,
          ...(Object.prototype.hasOwnProperty.call(row, 'ttlMs') ? { ttlMs: integer(row.ttlMs, 1, 900000) } : {}) }
      })
      return request('/approvals', 'POST', 201, value => {
        const result = approvalResult(value)
        if (result.operationId !== body.operationId || result.rowKey !== body.rowKey) invalid()
        return result
      }, body, signal)
    },
    observe(grantId: string, signal?: AbortSignal): Promise<YidaOwnerObservation> {
      const id = checkedInput(() => uuid(grantId))
      return request(`/approvals/${id}`, 'GET', 200, value => observation(value, id), undefined, signal)
    },
    revoke(grantId: string, signal?: AbortSignal): Promise<YidaOwnerApprovalResult> {
      const id = checkedInput(() => uuid(grantId))
      return request(`/approvals/${id}/revoke`, 'POST', 200, value => {
        const result = approvalResult(value)
        if (result.grantId !== id) invalid()
        return result
      }, {}, signal)
    },
    submit(input: YidaOwnerSubmissionInput, signal?: AbortSignal): Promise<YidaOwnerSubmission> {
      const body = checkedInput(() => { const row = object(input, ['grantId', 'submissionId']); return { grantId: uuid(row.grantId), submissionId: uuid(row.submissionId) } })
      return request('/submissions', 'POST', 200, value => submission(value, body.grantId), body, signal)
    },
  }
}
export type YidaOwnerClient = ReturnType<typeof createYidaOwnerClient>
