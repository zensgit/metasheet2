import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'

export type YidaAutomationRule = Readonly<{ id: string; sheetId: string; name: string; slot: string;
  revision: string; intervalMs: number; enabled: boolean }>
export type YidaAutomationConsent = Readonly<{ confirmationId: string; ruleId: string; expectedRuleRevision: string;
  actionId: string; projectNo: string; operationId: string; rowKeys: readonly string[];
  allowedTriggers: readonly ('manual' | 'schedule.interval')[]; maxExecutions: number; ttlMs: number }>
export type YidaAutomationSummary = Readonly<{ grantId: string; usedExecutions: number; maxExecutions: number;
  expiresAt: number; activeRequestId: string | null; status: 'recorded' | 'revoked' | 'stale' | 'clock_untrusted' | 'expired';
  revoked: boolean; canSend: false; externalWriteAttempted: false; liveEligibilityChecked: false }>
export type YidaAutomationObservation = YidaAutomationSummary & Readonly<{ serialBlocked: boolean; requests: readonly Readonly<{
  requestId: string; rowOrdinal: number; status: string; admissionId: string | null; ledgerStatus: string | null; durable: true; canSend: false }>[] }>
export class YidaAutomationClientError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'YidaAutomationClientError'; this.code = code }
}
type Data = Record<string, unknown>
const prefix = '/api/integration/yida-automation-authorizations'
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const actionType = 'integration_yida_send_authorized'
const maximumBytes = 1024 * 1024
const errorStatuses: Readonly<Record<string, readonly number[]>> = {
  YIDA_AUTOMATION_HTTP_INPUT: [400, 413, 415], YIDA_AUTOMATION_HTTP_UNAUTHORIZED: [401],
  YIDA_AUTOMATION_HTTP_DENIED: [403], YIDA_AUTOMATION_HTTP_UNAVAILABLE: [503],
  YIDA_AUTOMATION_MANAGEMENT_INPUT: [400], YIDA_AUTOMATION_MANAGEMENT_DENIED: [403],
  YIDA_AUTOMATION_MANAGEMENT_CONFLICT: [409], YIDA_AUTOMATION_MANAGEMENT_CLOSED: [503],
  VALIDATION_ERROR: [400], YIDA_AUTOMATION_AUTHORING_INVALID: [400], SERVICE_UNAVAILABLE: [503], DB_NOT_READY: [503],
  FORBIDDEN: [403], SHEET_DELETED: [409], INTERNAL_ERROR: [500],
}
function invalid(): never { throw new YidaAutomationClientError('YIDA_AUTOMATION_RESPONSE_INVALID') }
function plain(value: unknown): Data { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Data }
function exact(value: unknown, keys: readonly string[]): Data {
  const row = plain(value), actual = Object.keys(row)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid()
  return row
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}
function uuid(value: unknown): string { const result = id(value); if (!uuidPattern.test(result)) invalid(); return result }
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
function checked<T>(parse: () => T): T { try { return parse() } catch { throw new YidaAutomationClientError('YIDA_AUTOMATION_INPUT_INVALID') } }
function consent(value: unknown): YidaAutomationConsent {
  const row = exact(value, ['confirmationId','ruleId','expectedRuleRevision','actionId','projectNo','operationId','rowKeys','allowedTriggers','maxExecutions','ttlMs'])
  if (!Array.isArray(row.rowKeys) || row.rowKeys.length < 1 || row.rowKeys.length > 10
    || Object.keys(row.rowKeys).length !== row.rowKeys.length) invalid()
  const rowKeys = row.rowKeys.map(uuid), maxExecutions = integer(row.maxExecutions, 1, 10)
  if (new Set(rowKeys).size !== rowKeys.length || rowKeys.length > maxExecutions
    || !Array.isArray(row.allowedTriggers) || !row.allowedTriggers.length || row.allowedTriggers.length > 2
    || Object.keys(row.allowedTriggers).length !== row.allowedTriggers.length
    || row.allowedTriggers.some(trigger => trigger !== 'manual' && trigger !== 'schedule.interval')
    || new Set(row.allowedTriggers).size !== row.allowedTriggers.length) invalid()
  return Object.freeze({ confirmationId: id(row.confirmationId), ruleId: id(row.ruleId), expectedRuleRevision: uuid(row.expectedRuleRevision),
    actionId: id(row.actionId), projectNo: id(row.projectNo), operationId: id(row.operationId), rowKeys: Object.freeze(rowKeys),
    allowedTriggers: Object.freeze([...row.allowedTriggers]) as YidaAutomationConsent['allowedTriggers'], maxExecutions, ttlMs: integer(row.ttlMs, 1, 900000) })
}
const summaryKeys = ['grantId','usedExecutions','maxExecutions','expiresAt','activeRequestId','status','revoked','canSend','externalWriteAttempted','liveEligibilityChecked']
function summary(value: unknown, extra: readonly string[] = []): YidaAutomationSummary {
  const row = exact(value, [...summaryKeys, ...extra]), maximum = integer(row.maxExecutions, 1, 10)
  const used = integer(row.usedExecutions, 0, maximum)
  if (row.activeRequestId !== null && (!uuid(row.activeRequestId) || used === 0)
    || !['recorded','revoked','stale','clock_untrusted','expired'].includes(String(row.status))
    || row.revoked !== (row.status === 'revoked') || row.canSend !== false
    || row.externalWriteAttempted !== false || row.liveEligibilityChecked !== false) invalid()
  return Object.freeze({ grantId: uuid(row.grantId), maxExecutions: maximum, usedExecutions: used,
    expiresAt: integer(row.expiresAt, 1, 8640000000000000), activeRequestId: row.activeRequestId as string | null,
    status: row.status as YidaAutomationSummary['status'], revoked: row.revoked as boolean,
    canSend: false, externalWriteAttempted: false, liveEligibilityChecked: false })
}
function observation(value: unknown): YidaAutomationObservation {
  const row = plain(value), base = summary(row, ['requests','serialBlocked'])
  if (!Array.isArray(row.requests) || row.requests.length > 10 || Object.keys(row.requests).length !== row.requests.length
    || row.serialBlocked !== (base.activeRequestId !== null)) invalid()
  const requests = row.requests.map((value, index) => {
    const item = exact(value, ['requestId','rowOrdinal','status','admissionId','ledgerStatus','durable','canSend'])
    if (item.rowOrdinal !== index || item.canSend !== false || item.durable !== true
      || !['queued','admitted','closed_observed','closed_unknown','closed_not_sent'].includes(String(item.status))) invalid()
    if (item.status === 'queued') { if (item.admissionId !== null || item.ledgerStatus !== null) invalid() }
    else {
      uuid(item.admissionId)
      if (!['prepared','dispatching','acknowledged','outcome_unknown','not_sent'].includes(String(item.ledgerStatus))
        || item.status === 'closed_observed' && item.ledgerStatus !== 'acknowledged'
        || item.status === 'closed_unknown' && item.ledgerStatus !== 'outcome_unknown'
        || item.status === 'closed_not_sent' && item.ledgerStatus !== 'not_sent') invalid()
    }
    return Object.freeze({ requestId: uuid(item.requestId), rowOrdinal: index, status: String(item.status),
      admissionId: item.admissionId as string | null, ledgerStatus: item.ledgerStatus as string | null, durable: true as const, canSend: false as const })
  })
  if (requests.filter(item => item.admissionId !== null).length !== base.usedExecutions
    || new Set(requests.map(item => item.requestId)).size !== requests.length) invalid()
  return Object.freeze({ ...base, requests: Object.freeze(requests), serialBlocked: base.activeRequestId !== null })
}
function rule(value: unknown, sheetId: string): YidaAutomationRule {
  const row = plain(value), config = exact(row.actionConfig, ['authorizationSlot']), trigger = exact(row.triggerConfig, ['intervalMs'])
  if (row.sheetId !== sheetId || row.actionType !== actionType || row.triggerType !== 'schedule.interval' || typeof row.enabled !== 'boolean'
    || row.executionMode !== null && row.executionMode !== 'legacy' || row.conditions !== undefined && row.conditions !== null
    && (!Array.isArray(row.conditions) || row.conditions.length !== 0)) invalid()
  if (row.actions !== null && row.actions !== undefined) {
    if (!Array.isArray(row.actions) || row.actions.length > 1) invalid()
    if (row.actions.length) {
      const only = exact(row.actions[0], ['type','config'])
      if (only.type !== actionType || exact(only.config, ['authorizationSlot']).authorizationSlot !== config.authorizationSlot) invalid()
    }
  }
  return Object.freeze({ id: id(row.id), sheetId, slot: id(config.authorizationSlot), revision: uuid(row.integrationAuthorityRevision),
    name: typeof row.name === 'string' ? row.name.slice(0, 256) : '', enabled: row.enabled, intervalMs: integer(trigger.intervalMs, 1000, 2147483647) })
}

/** Fixed same-origin routes only. No configurable headers, origins, scope,
 * credential fields or local persistence. Session equality is not authority. */
export function createYidaAutomationClient(options: { onInvalidated?: () => void } = {}) {
  const token = readStoredToken(), signature = readAuthSessionSignature()
  if (!token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    || signature === 'invalid' || token !== readStoredToken()) throw new YidaAutomationClientError('UNAUTHORIZED')
  const scope = () => { try { return JSON.stringify([localStorage.getItem('tenantId'),localStorage.getItem('workspaceId'),localStorage.getItem(EXPLICIT_SESSION_ORG_KEY)]) } catch { return 'invalid' } }
  const initialScope = scope(), controllers = new Set<AbortController>()
  let disposed = false, unsubscribe = () => {}
  function dispose() {
    if (disposed) return
    disposed = true; unsubscribe(); window.removeEventListener('storage', changed); window.removeEventListener('focus', focus)
    controllers.forEach(controller => controller.abort()); controllers.clear()
  }
  function invalidate() { if (!disposed) { dispose(); options.onInvalidated?.() } }
  function current() {
    if (readStoredToken() !== token || readAuthSessionSignature() !== signature || scope() !== initialScope) invalidate()
    if (disposed) throw new YidaAutomationClientError('YIDA_AUTOMATION_SESSION_CHANGED')
  }
  function changed(event: StorageEvent) {
    if (event.key === null || [EXPLICIT_SESSION_ORG_KEY,'tenantId','workspaceId',...TOKEN_KEYS].includes(event.key)) invalidate()
  }
  // Event listeners must not throw into the browser's unrelated focus event.
  const focus = () => { try { current() } catch { /* Callback already invalidated the owning panel. */ } }
  unsubscribe = onAuthPrincipalChange(invalidate)
  window.addEventListener('storage', changed); window.addEventListener('focus', focus)
  async function request<T>(path: string, method: 'GET' | 'POST', statuses: readonly number[], parse: (value: unknown, status: number) => T, body?: unknown): Promise<T> {
    current()
    const controller = new AbortController(); controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 15000)
    const live = () => { current(); if (controller.signal.aborted) throw new YidaAutomationClientError('YIDA_AUTOMATION_CANCELLED') }
    try {
      let response: Response
      try { response = await fetch(path, { method, credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
      catch { live(); throw new YidaAutomationClientError('YIDA_AUTOMATION_UNAVAILABLE') }
      live()
      if (response.status === 401) { invalidate(); throw new YidaAutomationClientError('UNAUTHORIZED') }
      let envelope: Data
      try {
        const contentType = response.headers.get('content-type'), length = response.headers.get('content-length')
        if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType) || !response.body
          || length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximumBytes)) invalid()
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0, text = ''
        try {
          for (;;) { const chunk = await reader.read(); live(); if (chunk.done) break
            bytes += chunk.value.byteLength; if (bytes > maximumBytes) invalid(); text += decoder.decode(chunk.value, { stream: true }) }
          text += decoder.decode()
        } finally { reader.releaseLock() }
        envelope = exact(JSON.parse(text), response.ok ? ['ok','data'] : ['ok','error'])
        if (envelope.ok !== response.ok) invalid()
      } catch { live(); controller.abort(); throw new YidaAutomationClientError('YIDA_AUTOMATION_RESPONSE_INVALID') }
      if (!response.ok) {
        const error = plain(envelope.error)
        if (typeof error.code !== 'string' || !Object.prototype.hasOwnProperty.call(errorStatuses, error.code) || !errorStatuses[error.code].includes(response.status)) invalid()
        throw new YidaAutomationClientError(error.code)
      }
      if (!statuses.includes(response.status)) invalid()
      const result = parse(envelope.data, response.status); live(); return result
    } finally { clearTimeout(timer); controllers.delete(controller) }
  }
  return Object.freeze({ dispose() { window.removeEventListener('focus', focus); dispose() },
    async listRules(sheet: string) {
      const sheetId = checked(() => id(sheet))
      return request(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations`, 'GET', [200], value => {
        const row = exact(value, ['rules']); if (!Array.isArray(row.rules) || row.rules.length > 1000) invalid()
        const rules = row.rules.filter(value => plain(value).actionType === actionType).map(value => rule(value, sheetId))
        if (new Set(rules.map(item => item.id)).size !== rules.length) invalid()
        return Object.freeze(rules)
      })
    },
    async createRule(sheet: string, slot: string, milliseconds: number) {
      const sheetId = checked(() => id(sheet)), authorizationSlot = checked(() => id(slot)), intervalMs = checked(() => integer(milliseconds, 1000, 2147483647))
      return request(`/api/multitable/sheets/${encodeURIComponent(sheetId)}/automations`, 'POST', [200], value => {
        const saved = rule(exact(value, ['rule']).rule, sheetId)
        if (saved.slot !== authorizationSlot || saved.intervalMs !== intervalMs || !saved.enabled) invalid()
        return saved
      }, { name: '宜搭有限授权', enabled: true, triggerType: 'schedule.interval', triggerConfig: { intervalMs },
        actionType, actionConfig: { authorizationSlot }, actions: null, conditions: null, executionMode: 'legacy' })
    },
    async createApproval(input: YidaAutomationConsent) {
      const body = checked(() => consent(input))
      return request(prefix, 'POST', [200,201], (value, status) => {
        const raw = plain(value), parsed = summary(raw, ['reused'])
        if (typeof raw.reused !== 'boolean' || status !== (raw.reused ? 200 : 201)
          || parsed.maxExecutions !== body.maxExecutions) invalid()
        return Object.freeze({ ...parsed, reused: raw.reused })
      }, body)
    },
    async inspect(grant: string) { const key = checked(() => uuid(grant)); return request(`${prefix}/${key}`, 'GET', [200], value => {
      const result = observation(value); if (result.grantId !== key) invalid(); return result
    }) },
    async revoke(grant: string) { const key = checked(() => uuid(grant)); return request(`${prefix}/${key}/revoke`, 'POST', [200], value => {
      const result = summary(value); if (result.grantId !== key || !result.revoked) invalid(); return result
    }, {}) },
    async requestManual(grant: string, key: string) {
      const grantId = checked(() => uuid(grant)), requestKey = checked(() => id(key))
      return request(`${prefix}/${grantId}/requests`, 'POST', [200,202], (value, status) => {
        const row = exact(value, ['requestId','rowOrdinal','reused','deliveryQueued','canSend','externalWriteAttempted'])
        if (typeof row.reused !== 'boolean' || status !== (row.reused ? 200 : 202)
          || row.deliveryQueued !== true || row.canSend !== false || row.externalWriteAttempted !== false) invalid()
        return Object.freeze({ requestId: uuid(row.requestId), rowOrdinal: integer(row.rowOrdinal, 0, 9), reused: row.reused,
          deliveryQueued: true as const, canSend: false as const, externalWriteAttempted: false as const })
      }, { requestKey })
    },
  })
}
