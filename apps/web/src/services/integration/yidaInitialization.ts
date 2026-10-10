import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import type { YidaOwnerDraft, YidaOwnerDraftInput } from './yidaOwner'

export interface YidaInitializationMaterial {
  readonly appKey: string
  readonly appSecret: string
  readonly systemToken: string
  readonly userId: string
}
export interface YidaInitializationInput {
  readonly commandId: string
  readonly material: YidaInitializationMaterial
  readonly draft: YidaOwnerDraftInput
  readonly attestation: Readonly<{ kind: 'owner-reviewed-target'; reviewRef: string; organizationId: string; executionIdentity: string }>
}
export interface YidaInitializationState {
  readonly commandId: string
  readonly status: 'ready' | 'initialized'
  readonly draft: YidaOwnerDraft | null
  readonly canSend: false
  readonly tokenIssued: false
  readonly externalWriteAttempted: false
}

const endpoint = '/api/integration/yida-owner-send/initialization'
const maximumBodyBytes = 1024 * 1024
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const errorStatuses: Readonly<Record<string, readonly number[]>> = Object.freeze({
  UNAUTHORIZED: [401], NOT_FOUND: [404], YIDA_OWNER_HTTP_INPUT: [400, 413, 415],
  YIDA_OWNER_HTTP_DENIED: [403], YIDA_OWNER_HTTP_UNAVAILABLE: [503],
  YIDA_INITIALIZATION_INPUT: [400], YIDA_INITIALIZATION_DENIED: [403], YIDA_INITIALIZATION_CONFLICT: [409],
  YIDA_INITIALIZATION_INACTIVE: [503], YIDA_INITIALIZATION_CANCELLED: [409], YIDA_INITIALIZATION_UNAVAILABLE: [503],
})
export class YidaInitializationClientError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'YidaInitializationClientError'; this.code = code }
}
type Row = Record<string, unknown>
function invalid(): never { throw new YidaInitializationClientError('YIDA_INITIALIZATION_RESPONSE_INVALID') }
function object(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Row
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key))) invalid()
  return row
}
function canonical(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}
function uuid(value: unknown): string { const result = canonical(value); if (!uuidPattern.test(result)) invalid(); return result }
function draft(value: unknown): YidaOwnerDraft {
  const row = object(value, ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply', 'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'])
  if (row.status !== 'unverified' || row.identityKind !== 'local-unverified' || row.canSend !== false || row.canApply !== false
    || row.tokenIssued !== false || row.externalWriteAttempted !== false || !Array.isArray(row.rows)
    || row.rows.length < 1 || row.rows.length > 100 || row.rowCount !== row.rows.length || typeof row.reused !== 'boolean') invalid()
  const rows = row.rows.map((value, index) => {
    const member = object(value, ['rowKey', 'index'])
    if (member.index !== index) invalid()
    return Object.freeze({ rowKey: uuid(member.rowKey), index })
  })
  if (new Set(rows.map(member => member.rowKey)).size !== rows.length) invalid()
  return Object.freeze({ targetRef: uuid(row.targetRef), operationId: uuid(row.operationId), status: 'unverified', identityKind: 'local-unverified',
    canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: rows.length, rows: Object.freeze(rows), reused: row.reused })
}
function state(value: unknown, expectedCommand: string | null): YidaInitializationState {
  const row = object(value, ['commandId', 'status', 'draft', 'canSend', 'tokenIssued', 'externalWriteAttempted'])
  const commandId = uuid(row.commandId)
  if (expectedCommand !== null && commandId !== expectedCommand) invalid()
  if (row.canSend !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false
    || (row.status !== 'ready' && row.status !== 'initialized') || (row.status === 'ready') !== (row.draft === null)) invalid()
  return Object.freeze({ commandId, status: row.status, draft: row.draft === null ? null : draft(row.draft),
    canSend: false, tokenIssued: false, externalWriteAttempted: false })
}
function input(value: unknown): YidaInitializationInput {
  try {
    const row = object(value, ['commandId', 'material', 'draft', 'attestation'])
    const material = object(row.material, ['appKey', 'appSecret', 'systemToken', 'userId'])
    for (const key of ['appKey', 'appSecret', 'systemToken', 'userId']) {
      const field = material[key]
      if (typeof field !== 'string' || !field.trim() || field.length > (key === 'userId' ? 128 : 4096)) invalid()
    }
    const reviewed = object(row.attestation, ['kind', 'reviewRef', 'organizationId', 'executionIdentity'])
    if (reviewed.kind !== 'owner-reviewed-target' || reviewed.executionIdentity !== material.userId) invalid()
    const fixedDraft = object(row.draft, ['config', 'rowsText', 'allocation'])
    if (typeof fixedDraft.rowsText !== 'string' || new TextEncoder().encode(fixedDraft.rowsText).length > 128 * 1024) invalid()
    const config = fixedDraft.config as Row | null
    if (!config || config.version !== 2 || config.intent !== 'create') invalid()
    const result = { commandId: uuid(row.commandId), material: { appKey: material.appKey, appSecret: material.appSecret, systemToken: material.systemToken, userId: material.userId },
      draft: fixedDraft, attestation: { kind: 'owner-reviewed-target', reviewRef: canonical(reviewed.reviewRef),
        organizationId: canonical(reviewed.organizationId), executionIdentity: canonical(reviewed.executionIdentity) } }
    const text = JSON.stringify(result)
    if (new TextEncoder().encode(text).length > maximumBodyBytes) invalid()
    // Detach, but never trim/normalize any material string. The host replays the actual draft.
    return JSON.parse(text) as YidaInitializationInput
  } catch { throw new YidaInitializationClientError('YIDA_INITIALIZATION_INPUT_INVALID') }
}

/** Independent local management path, not a sending capability. Captured-session
 * and bounded original-reader guards mirror yidaOwner; no retries or persisted
 * payload/command keys. Each POST consumes a successful explicit ready GET. */
export function createYidaInitializationClient(options: { onInvalidated?: () => void } = {}) {
  const token = readStoredToken(), signature = readAuthSessionSignature()
  if (!token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    || signature === 'invalid' || token !== readStoredToken()) throw new YidaInitializationClientError('UNAUTHORIZED')
  const scopeHint = () => { try { return JSON.stringify([localStorage.getItem('tenantId'), localStorage.getItem('workspaceId')]) } catch { return 'invalid' } }
  const startedScope = scopeHint()
  let disposed = false, ready = false, pending = false, commandId: string | null = null
  const controllers = new Set<AbortController>()
  let unsubscribe = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true; ready = false
    unsubscribe(); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', checkSession)
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  const invalidate = () => { if (disposed) return; dispose(); options.onInvalidated?.() }
  const checkSession = () => { if (readAuthSessionSignature() !== signature || readStoredToken() !== token || scopeHint() !== startedScope) invalidate() }
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || event.key === 'tenantId' || event.key === 'workspaceId'
      || TOKEN_KEYS.some(key => key === event.key)) invalidate()
  }
  unsubscribe = onAuthPrincipalChange(invalidate)
  window.addEventListener('storage', onStorage); window.addEventListener('focus', checkSession)
  const assertCurrentSession = () => { checkSession(); if (disposed) throw new YidaInitializationClientError('YIDA_INITIALIZATION_SESSION_CHANGED') }
  async function request(method: 'GET' | 'POST', expectedCommand: string | null, body?: YidaInitializationInput, signal?: AbortSignal): Promise<YidaInitializationState> {
    assertCurrentSession()
    if (pending) throw new YidaInitializationClientError('YIDA_INITIALIZATION_STATE_UNCONFIRMED')
    pending = true
    const controller = new AbortController(), abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); controllers.add(controller)
    const timeout = setTimeout(abort, 15000)
    const current = () => { assertCurrentSession(); if (controller.signal.aborted) throw new YidaInitializationClientError('YIDA_INITIALIZATION_CANCELLED') }
    try {
      current()
      let response: Response
      try {
        response = await fetch(endpoint, { method, credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch { current(); throw new YidaInitializationClientError('YIDA_INITIALIZATION_UNAVAILABLE') }
      current()
      if (response.status === 401) { invalidate(); throw new YidaInitializationClientError('UNAUTHORIZED') }
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
      } catch { current(); controller.abort(); throw new YidaInitializationClientError('YIDA_INITIALIZATION_RESPONSE_INVALID') }
      if (!response.ok) {
        const error = object(envelope.error, ['code'])
        if (typeof error.code !== 'string' || !Object.hasOwn(errorStatuses, error.code) || !errorStatuses[error.code].includes(response.status)) invalid()
        if (error.code === 'YIDA_OWNER_HTTP_DENIED' || error.code === 'YIDA_INITIALIZATION_DENIED') invalidate()
        throw new YidaInitializationClientError(error.code)
      }
      if (response.status !== (method === 'GET' ? 200 : 201)) invalid()
      const result = state(envelope.data, expectedCommand)
      current()
      return result
    } finally { pending = false; clearTimeout(timeout); signal?.removeEventListener('abort', abort); controllers.delete(controller) }
  }
  return {
    dispose, assertCurrentSession,
    async observe(signal?: AbortSignal): Promise<YidaInitializationState> {
      ready = false
      const result = await request('GET', commandId, undefined, signal)
      commandId = result.commandId; ready = result.status === 'ready'
      return result
    },
    async initialize(value: YidaInitializationInput, signal?: AbortSignal): Promise<YidaInitializationState> {
      assertCurrentSession()
      if (!ready || commandId === null || value.commandId !== commandId) throw new YidaInitializationClientError('YIDA_INITIALIZATION_STATE_UNCONFIRMED')
      const body = input(value)
      ready = false
      const result = await request('POST', commandId, body, signal)
      if (result.status !== 'initialized') invalid()
      return result
    },
  }
}
