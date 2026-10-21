import { types } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express'
import { checkedYidaAutomationAuthorization, checkedYidaAutomationRequest,
  type YidaAutomationAuthorizationInput } from '../integration/yida-automation-authorization-contracts'
import { yidaAutomationManagementErrorCode } from '../integration/yida-automation-authorization-service'
import type { AutomationIntegrationActor } from '../integration/automation-live-authority'
import { checkedReconciliationInput, checkedReconciliationPage, checkedReconciliationRecord,
  reconciliationErrorCode } from '../integration/yida-reconciliation-contracts'

// GOV-08 SA-06D: four authorization operations plus append/list operator facts,
// never an alias for the manual
// send port. Mount only AFTER real JWT and the corresponding installed host.
// This module does not install a worker, accept a binding, or change auth gates.
export { YIDA_AUTOMATION_HTTP_PREFIX } from '../integration/yida-owner-http-observation'
type Consent = Omit<YidaAutomationAuthorizationInput, 'maxTotalRows'>
type Options = Readonly<{ signal: AbortSignal }>
export type YidaAutomationHttpPort = Readonly<{
  create(actor: AutomationIntegrationActor, consent: Consent, options: Options): Promise<unknown>
  inspect(actor: AutomationIntegrationActor, grantId: string, options: Options): Promise<unknown>
  revoke(actor: AutomationIntegrationActor, grantId: string, options: Options): Promise<unknown>
  requestManual(actor: AutomationIntegrationActor, grantId: string, input: Readonly<{ requestKey: string }>, options: Options): Promise<unknown>
  appendObservation(actor: AutomationIntegrationActor, grantId: string, requestId: string, input: unknown, options: Options): Promise<unknown>
  listObservations(actor: AutomationIntegrationActor, grantId: string, requestId: string, afterId: string | null, options: Options): Promise<unknown>
}>
type Data = Record<string, unknown>
type Code = 'INPUT' | 'UNAUTHORIZED' | 'DENIED' | 'UNAVAILABLE'
const ownErrors = new WeakMap<object, Code>()
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const scopeHeaders = new Set(['tenant', 'tenantid', 'workspace', 'workspaceid', 'org', 'orgid', 'organization',
  'organizationid', 'scope', 'managementscope', 'principal', 'principalid', 'actor', 'actorid', 'owner', 'ownerid',
  'user', 'userid', 'actas', 'onbehalfof', 'impersonate', 'impersonation', 'projectid', 'projectno'])
function fail(code: Code = 'INPUT'): never {
  const error = new Error('YIDA_AUTOMATION_HTTP_' + code)
  ownErrors.set(error, code); throw error
}
function data(value: unknown, keys: readonly string[]): Data {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()
  const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(descriptors).length !== keys.length) fail()
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    return [key, descriptor.value]
  }))
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}
function uuid(value: unknown): string { const result = text(value); if (!UUID.test(result)) fail(); return result }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail()
  return value
}
function empty(value: unknown) { data(value === undefined ? {} : value, []) }
function actor(req: Request): Readonly<AutomationIntegrationActor> {
  if (!req.user?.id) fail('UNAUTHORIZED')
  const actorId = text(req.user.id)
  // user.tenantId can be populated from x-tenant-id by the legacy middleware;
  // only the authenticated JWT tenant claim is admissible here.
  if (!req.authenticatedTenantId) fail('DENIED')
  const tenantId = text(req.authenticatedTenantId)
  for (const key of Object.keys(req.headers)) {
    if (scopeHeaders.has(key.toLowerCase().replace(/^x[-_]/u, '').replace(/[-_]/gu, ''))) fail()
  }
  return Object.freeze({ actorId, tenantId, workspaceId: null })
}
const summaryKeys = ['grantId', 'usedExecutions', 'maxExecutions', 'expiresAt', 'activeRequestId',
  'status', 'revoked', 'canSend', 'externalWriteAttempted', 'liveEligibilityChecked'] as const
function summary(value: unknown, extra: readonly string[] = []): Data {
  const row = data(value, [...summaryKeys, ...extra])
  uuid(row.grantId)
  const maximum = integer(row.maxExecutions, 1, 10)
  integer(row.usedExecutions, 0, maximum); integer(row.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  if (row.activeRequestId !== null) { uuid(row.activeRequestId); if (row.usedExecutions === 0) fail() }
  if (typeof row.status !== 'string' || !['recorded', 'revoked', 'stale', 'clock_untrusted', 'expired'].includes(row.status)
    || row.revoked !== (row.status === 'revoked') || row.canSend !== false
    || row.externalWriteAttempted !== false || row.liveEligibilityChecked !== false) fail()
  return row
}
function requests(value: unknown) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10
    || Reflect.ownKeys(value).length !== value.length + 1) fail()
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index))
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail()
    const row = data(property.value, ['requestId', 'rowOrdinal', 'status', 'admissionId', 'ledgerStatus', 'durable', 'canSend'])
    uuid(row.requestId)
    if (row.rowOrdinal !== index || row.durable !== true || row.canSend !== false
      || typeof row.status !== 'string'
      || !['queued', 'admitted', 'closed_observed', 'closed_unknown', 'closed_not_sent'].includes(row.status)) fail()
    if (row.status === 'queued') {
      if (row.admissionId !== null || row.ledgerStatus !== null) fail()
    } else {
      uuid(row.admissionId)
      if (typeof row.ledgerStatus !== 'string'
        || !['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(row.ledgerStatus)
        || row.status === 'closed_observed' && row.ledgerStatus !== 'acknowledged'
        || row.status === 'closed_unknown' && row.ledgerStatus !== 'outcome_unknown'
        || row.status === 'closed_not_sent' && row.ledgerStatus !== 'not_sent') fail()
    }
    return Object.freeze(row)
  }))
}
function observation(value: unknown) {
  const row = summary(value, ['requests', 'serialBlocked']), entries = requests(row.requests)
  if (row.serialBlocked !== (row.activeRequestId !== null)
    || entries.filter(entry => entry.admissionId !== null).length !== row.usedExecutions) fail()
  return Object.freeze({ ...row, requests: entries })
}
function acceptance(value: unknown) {
  const row = data(value, ['requestId', 'rowOrdinal', 'reused', 'deliveryQueued', 'canSend', 'externalWriteAttempted'])
  uuid(row.requestId); integer(row.rowOrdinal, 0, 9)
  if (typeof row.reused !== 'boolean' || row.deliveryQueued !== true || row.canSend !== false || row.externalWriteAttempted !== false) fail()
  return Object.freeze(row)
}
function dto<T>(read: () => T): T { try { return read() } catch { return fail('UNAVAILABLE') } }
function sendError(res: Response, error: unknown) {
  const own = ownErrors.get(error as object), management = yidaAutomationManagementErrorCode(error)
  const reconciliation = reconciliationErrorCode(error)
  const code = own ? 'YIDA_AUTOMATION_HTTP_' + own : management ?? (reconciliation ? 'YIDA_RECONCILIATION_' + reconciliation : 'YIDA_AUTOMATION_HTTP_UNAVAILABLE')
  const statuses: Readonly<Record<string, number>> = {
    YIDA_AUTOMATION_HTTP_INPUT: 400, YIDA_AUTOMATION_HTTP_UNAUTHORIZED: 401,
    YIDA_AUTOMATION_HTTP_DENIED: 403, YIDA_AUTOMATION_HTTP_UNAVAILABLE: 503,
    YIDA_AUTOMATION_MANAGEMENT_INPUT: 400, YIDA_AUTOMATION_MANAGEMENT_DENIED: 403,
    YIDA_AUTOMATION_MANAGEMENT_CONFLICT: 409, YIDA_AUTOMATION_MANAGEMENT_CLOSED: 503,
    YIDA_RECONCILIATION_INPUT: 400, YIDA_RECONCILIATION_DENIED: 403,
    YIDA_RECONCILIATION_CONFLICT: 409, YIDA_RECONCILIATION_UNAVAILABLE: 503,
  }
  // An exported JS error constructor can be called with a value outside its
  // TypeScript union. Even an owned WeakMap entry is not a wire-code allowlist.
  const safeCode = Object.hasOwn(statuses, code) ? code : 'YIDA_AUTOMATION_HTTP_UNAVAILABLE'
  if (!res.destroyed && !res.writableEnded) res.status(statuses[safeCode]).json({ ok: false, error: { code: safeCode } })
}
export const yidaAutomationNoStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next()
}
export const yidaAutomationJsonOnly: RequestHandler = (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    res.status(415).json({ ok: false, error: { code: 'YIDA_AUTOMATION_HTTP_INPUT' } }); return
  }
  next()
}
export function yidaAutomationBodyLimit(req: IncomingMessage, _res: ServerResponse, body: Buffer) {
  // Match Express's case-insensitive route semantics, including trailing slash.
  if (body.length > 4096 && /\/observations(?:[/?]|$)/iu.test(req.url ?? '')) {
    throw Object.assign(new Error('YIDA_RECONCILIATION_INPUT'), { type: 'entity.too.large' })
  }
}
export const yidaAutomationParseError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  const type = error && typeof error === 'object' && !types.isProxy(error)
    ? Object.getOwnPropertyDescriptor(error, 'type')?.value : undefined
  const status = type === 'entity.too.large' ? 413
    : typeof type === 'string' && ['entity.parse.failed', 'request.aborted', 'request.size.invalid'].includes(type) ? 400
      : typeof type === 'string' && ['charset.unsupported', 'encoding.unsupported'].includes(type) ? 415 : 503
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json({ ok: false, error: { code: status === 503 ? 'YIDA_AUTOMATION_HTTP_UNAVAILABLE' : 'YIDA_AUTOMATION_HTTP_INPUT' } })
}
export function createIntegrationYidaAutomationRouter(port: YidaAutomationHttpPort): Router {
  if (!port || typeof port !== 'object' || types.isProxy(port)) fail('UNAVAILABLE')
  const take = <K extends keyof YidaAutomationHttpPort>(key: K): YidaAutomationHttpPort[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(port, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) fail('UNAVAILABLE')
    return descriptor.value.bind(port)
  }
  const create = take('create'), inspect = take('inspect'), revoke = take('revoke'), request = take('requestManual')
  const appendObservation = take('appendObservation'), listObservations = take('listObservations')
  const router = Router()
  const route = (operation: (req: Request, grantor: AutomationIntegrationActor, options: Options) => Promise<{ status: number; data: unknown }>) =>
    async (req: Request, res: Response) => {
      const controller = new AbortController(), aborted = () => controller.abort()
      const closed = () => { if (!res.writableEnded) controller.abort() }
      req.once('aborted', aborted); res.once('close', closed)
      try {
        if (req.aborted || res.destroyed) controller.abort()
        const grantor = actor(req); empty(req.query)
        if (controller.signal.aborted) fail('UNAVAILABLE')
        const result = await operation(req, grantor, Object.freeze({ signal: controller.signal }))
        if (!res.destroyed && !res.writableEnded) res.status(result.status).json({ ok: true, data: result.data })
      } catch (error) { sendError(res, error) }
      finally { req.removeListener('aborted', aborted); res.removeListener('close', closed) }
    }
  router.post('/', route(async (req, grantor, options) => {
    let consent: Consent
    try { const { maxTotalRows: _derived, ...input } = checkedYidaAutomationAuthorization(req.body); consent = input } catch { return fail() }
    const saved = await create(grantor, consent, options)
    const result = dto(() => {
      const row = summary(saved, ['reused'])
      if (typeof row.reused !== 'boolean') fail()
      return Object.freeze(row)
    })
    return { status: result.reused ? 200 : 201, data: result }
  }))
  router.get('/:grantId', route(async (req, grantor, options) => {
    empty(req.body)
    const result = await inspect(grantor, uuid(req.params.grantId), options)
    return { status: 200, data: dto(() => observation(result)) }
  }))
  router.post('/:grantId/revoke', route(async (req, grantor, options) => {
    empty(req.body)
    const result = await revoke(grantor, uuid(req.params.grantId), options)
    return { status: 200, data: dto(() => Object.freeze(summary(result))) }
  }))
  router.post('/:grantId/requests', route(async (req, grantor, options) => {
    let input: Readonly<{ requestKey: string }>
    try { input = checkedYidaAutomationRequest(req.body) } catch { return fail() }
    const saved = await request(grantor, uuid(req.params.grantId), input, options)
    const result = dto(() => acceptance(saved))
    return { status: result.reused ? 200 : 202, data: result }
  }))
  router.post('/:grantId/requests/:requestId/observations', route(async (req, grantor, options) => {
    const saved = await appendObservation(grantor, uuid(req.params.grantId), uuid(req.params.requestId),
      checkedReconciliationInput(req.body), options)
    const result = dto(() => {
      const row = data(saved, ['record', 'reused'])
      if (typeof row.reused !== 'boolean') fail()
      return { record: checkedReconciliationRecord(row.record), reused: row.reused }
    })
    return { status: result.reused ? 200 : 201, data: result }
  }))
  // Path cursor is an observation ID, resolved under the SAME authenticated
  // ledger. No tenant, owner, workspace, arbitrary query or offset controls.
  router.get('/:grantId/requests/:requestId/observations/:afterId?', route(async (req, grantor, options) => {
    empty(req.body)
    const saved = await listObservations(grantor, uuid(req.params.grantId), uuid(req.params.requestId),
      req.params.afterId === undefined ? null : uuid(req.params.afterId), options)
    return { status: 200, data: dto(() => checkedReconciliationPage(saved)) }
  }))
  return router
}
