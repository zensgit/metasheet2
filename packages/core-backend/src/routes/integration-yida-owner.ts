import { types } from 'node:util'
import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { yidaOwnerRuntimeErrorCode, type createYidaOwnerRuntime, type YidaOwnerActor } from '../integration/yida-owner-runtime'
import { yidaSendApprovalErrorCode } from '../integration/yida-send-approval-service'
import { yidaInitializationErrorCode, type YidaInitializationInput } from '../integration/yida-initialization-runtime'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../integration/yida-owner-http-observation'

/** Dedicated host owner boundary, after actual JWT. Never a communication API.
 * Preview values belong only to this authorized no-store response, not logs. */
export type YidaOwnerHttpPort = Pick<ReturnType<typeof createYidaOwnerRuntime>,
  'prepareDraft' | 'preview' | 'approve' | 'revoke' | 'observe' | 'submit'>
export type YidaInitializationHttpPort = Readonly<{
  status(actor: YidaOwnerActor, options: { signal: AbortSignal }): Promise<unknown>
  initialize(actor: YidaOwnerActor, input: YidaInitializationInput, options: { signal: AbortSignal }): Promise<unknown>
}>
type Data = Record<string, unknown>
const ownErrors = new WeakMap<object, string>()
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const HEX = /^[a-f0-9]{64}$/u
const scopeHeaders = new Set(['tenant', 'tenantid', 'workspace', 'workspaceid', 'org', 'orgid', 'organization',
  'organizationid', 'scope', 'managementscope', 'principal', 'principalid', 'actor', 'actorid', 'owner', 'ownerid',
  'user', 'userid', 'actas', 'onbehalfof', 'impersonate', 'impersonation', 'projectid', 'projectno'])
const statuses: Readonly<Record<string, number>> = Object.freeze({
  UNAUTHORIZED: 401, YIDA_OWNER_HTTP_INPUT: 400, YIDA_OWNER_HTTP_DENIED: 403, YIDA_OWNER_HTTP_UNAVAILABLE: 503,
  YIDA_OWNER_RUNTIME_INPUT: 400, YIDA_OWNER_RUNTIME_DISABLED: 403, YIDA_OWNER_RUNTIME_INACTIVE: 503,
  YIDA_OWNER_RUNTIME_UNAVAILABLE: 503, YIDA_OWNER_RUNTIME_CANCELLED: 409,
  YIDA_SEND_APPROVAL_INPUT: 400, YIDA_SEND_APPROVAL_NOT_FOUND: 404, YIDA_SEND_APPROVAL_CONFLICT: 409,
  YIDA_SEND_APPROVAL_EXPIRED: 409, YIDA_SEND_APPROVAL_REVOKED: 409,
  YIDA_SEND_APPROVAL_CANCELLED: 409, YIDA_SEND_APPROVAL_UNAVAILABLE: 503,
})
function fail(code = 'YIDA_OWNER_HTTP_INPUT'): never {
  const error = new Error(code)
  ownErrors.set(error, code)
  throw error
}
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Data {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))) fail()
  const result: Data = Object.create(null)
  for (const key of Object.keys(descriptors)) {
    const property = descriptors[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail()
    result[key] = property.value
  }
  return result
}
function literalId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}
function id(value: unknown): string { const result = literalId(value); if (!UUID.test(result)) fail(); return result }
function digest(value: unknown): string { if (typeof value !== 'string' || !HEX.test(value)) fail(); return value }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail()
  return value as number
}
function empty(value: unknown) { record(value === undefined ? {} : value, []) }
function actor(req: Request): YidaOwnerActor {
  if (!req.user?.id) fail('UNAUTHORIZED')
  const actorId = literalId(req.user.id)
  if (!req.authenticatedTenantId) fail('YIDA_OWNER_HTTP_DENIED')
  const tenantId = literalId(req.authenticatedTenantId)
  // Never adopt user.tenantId, body scope, x-tenant-id fallback or tenant ALS.
  for (const key of Object.keys(req.headers)) {
    const name = key.toLowerCase().replace(/^x[-_]/u, '').replace(/[-_]/gu, '')
    if (scopeHeaders.has(name)) fail()
  }
  return Object.freeze({ actorId, tenantId, workspaceId: null })
}
const metadataKeys = ['grantId', 'operationId', 'rowKey', 'targetRef', 'approvedAt', 'expiresAt', 'maxAttempts',
  'remainingAttempts', 'status', 'revoked', 'admissionId', 'ledgerId', 'canSend', 'externalWriteAttempted'] as const
function metadata(value: unknown, reuse = false): Data {
  const row = record(value, reuse ? [...metadataKeys, 'reused'] : metadataKeys)
  for (const key of ['grantId', 'operationId', 'rowKey', 'targetRef']) id(row[key])
  const approvedAt = integer(row.approvedAt, 1, Number.MAX_SAFE_INTEGER)
  const expiresAt = integer(row.expiresAt, approvedAt + 1, approvedAt + 900000)
  if (row.maxAttempts !== 1 || (row.remainingAttempts !== 0 && row.remainingAttempts !== 1)
    || typeof row.status !== 'string' || !['approved', 'expired', 'revoked', 'admitted'].includes(row.status)
    || typeof row.revoked !== 'boolean' || row.canSend !== false || row.externalWriteAttempted !== false
    || (reuse && typeof row.reused !== 'boolean')) fail()
  integer(row.remainingAttempts, 0, 1)
  if ((row.admissionId === null) !== (row.ledgerId === null)) fail()
  if (row.admissionId !== null) { id(row.admissionId); id(row.ledgerId) }
  if ((row.status === 'admitted') !== (row.admissionId !== null)
    || (row.status !== 'approved' && row.remainingAttempts !== 0)) fail()
  return { ...row, approvedAt, expiresAt }
}
const deliveryStates = ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent']
function delivery(value: unknown) {
  if (value === null) return null
  const row = record(value, ['id', 'status', 'durable'])
  if (typeof row.status !== 'string' || !deliveryStates.includes(row.status) || row.durable !== true) fail()
  return { id: id(row.id), status: row.status, durable: true }
}
function observation(value: unknown) {
  const row = record(value, ['approval', 'delivery'])
  const approval = metadata(row.approval), result = delivery(row.delivery)
  if ((approval.ledgerId === null) !== (result === null) || (result && result.id !== approval.ledgerId)) fail()
  return { approval, delivery: result }
}
function draft(value: unknown) {
  const row = record(value, ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply',
    'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'])
  if (row.status !== 'unverified' || row.identityKind !== 'local-unverified' || row.canSend !== false
    || row.canApply !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false
    || typeof row.reused !== 'boolean' || !Array.isArray(row.rows) || row.rows.length < 1 || row.rows.length > 100
    || row.rowCount !== row.rows.length) fail()
  return { ...row, targetRef: id(row.targetRef), operationId: id(row.operationId), rows: row.rows.map((item, index) => {
    const member = record(item, ['rowKey', 'index'])
    if (member.index !== index) fail()
    return { rowKey: id(member.rowKey), index }
  }) }
}
function preview(value: unknown) {
  const row = record(value, ['operationId', 'rowKey', 'planDigest', 'rowPayloadDigest', 'target', 'payload', 'policy', 'canSend', 'externalWriteAttempted'])
  const target = record(row.target, ['targetRef', 'identityKind', 'evidenceVersion', 'reviewRef', 'organizationId', 'appType', 'formUuid'])
  const policy = record(row.policy, ['intent', 'maxAttempts', 'maxTtlMs', 'requiresExplicitConfirmation', 'unknownMustNotRetry'])
  if (target.identityKind !== 'owner-attested-single-target' || target.evidenceVersion !== 1
    || policy.intent !== 'create' || policy.maxAttempts !== 1 || policy.maxTtlMs !== 900000
    || policy.requiresExplicitConfirmation !== true || policy.unknownMustNotRetry !== true
    || row.canSend !== false || row.externalWriteAttempted !== false) fail()
  for (const key of ['reviewRef', 'organizationId', 'appType', 'formUuid']) literalId(target[key])
  const payload = row.payload
  if (!payload || typeof payload !== 'object' || types.isProxy(payload) || Array.isArray(payload)) fail()
  const descriptors = Object.getOwnPropertyDescriptors(payload), entries = Reflect.ownKeys(descriptors)
  if (!entries.length || entries.length > 100) fail()
  const projected: Data = Object.create(null)
  for (const key of entries) {
    if (typeof key !== 'string' || !key || key.length > 128) fail()
    const property = descriptors[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail()
    const value = property.value
    if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) fail()
    projected[key] = value
  }
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > 256 * 1024) fail()
  return { operationId: id(row.operationId), rowKey: id(row.rowKey), planDigest: digest(row.planDigest),
    rowPayloadDigest: digest(row.rowPayloadDigest), target: { ...target, targetRef: id(target.targetRef) },
    payload: projected, policy, canSend: false, externalWriteAttempted: false }
}
function submission(value: unknown) {
  const row = record(value, ['approval', 'delivery', 'reused', 'status', 'externalWriteAttempted', 'businessVerified', 'durable'])
  const observed = observation({ approval: row.approval, delivery: row.delivery })
  if (typeof row.status !== 'string' || ![...deliveryStates, 'state_unconfirmed', 'not_started'].includes(row.status)
    || typeof row.reused !== 'boolean' || typeof row.durable !== 'boolean' || row.businessVerified !== false
    || typeof row.externalWriteAttempted !== 'boolean' || (row.reused && row.externalWriteAttempted !== false)) fail()
  return { ...observed, reused: row.reused, status: row.status, externalWriteAttempted: row.externalWriteAttempted,
    businessVerified: false, durable: row.durable }
}
function initializationInput(value: unknown) {
  const parsed = record(value, ['commandId', 'material', 'draft', 'attestation'])
  const material = record(parsed.material, ['appKey', 'appSecret', 'systemToken', 'userId'])
  for (const key of Object.keys(material)) {
    if (typeof material[key] !== 'string' || !material[key].trim() || material[key].length > (key === 'userId' ? 128 : 4096)) fail()
  }
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > 16 * 1024) fail()
  const candidate = record(parsed.draft, ['config', 'rowsText', 'allocation'])
  if (typeof candidate.rowsText !== 'string' || Buffer.byteLength(candidate.rowsText, 'utf8') > 128 * 1024) fail()
  const config = record(candidate.config, ['version', 'kind', 'target', 'intent', 'businessKey', 'fieldMap', 'fieldCatalog', 'emptyKeyFields'], ['instanceIdField'])
  if (config.version !== 2 || config.kind !== 'yida-form-protocol-static' || config.intent !== 'create') fail()
  record(config.target, ['appType', 'formUuid'])
  if (!Array.isArray(config.businessKey) || !Array.isArray(config.fieldMap) || !Array.isArray(config.fieldCatalog) || !Array.isArray(config.emptyKeyFields)) fail()
  const allocation = record(candidate.allocation, ['mode'], ['projects', 'projectField', 'quantityField'])
  if (allocation.mode === 'original') record(candidate.allocation, ['mode'])
  else if (!['equal_integer', 'equal_decimal_exact'].includes(String(allocation.mode))) fail()
  else record(candidate.allocation, ['mode', 'projects', 'projectField', 'quantityField'])
  const attestation = record(parsed.attestation, ['kind', 'reviewRef', 'organizationId', 'executionIdentity'])
  if (attestation.kind !== 'owner-reviewed-target') fail()
  for (const key of ['reviewRef', 'organizationId', 'executionIdentity']) literalId(attestation[key])
  if (attestation.executionIdentity !== material.userId) fail()
  return { commandId: id(parsed.commandId), material, draft: candidate, attestation }
}
function initialization(value: unknown) {
  const row = record(value, ['commandId', 'status', 'draft', 'canSend', 'tokenIssued', 'externalWriteAttempted'])
  if (!['ready', 'initialized'].includes(String(row.status)) || row.canSend !== false
    || row.tokenIssued !== false || row.externalWriteAttempted !== false
    || (row.status === 'ready') !== (row.draft === null)) fail()
  return { commandId: id(row.commandId), status: row.status,
    draft: row.draft === null ? null : draft(row.draft), canSend: false, tokenIssued: false, externalWriteAttempted: false }
}
function dto(project: () => unknown) { try { return project() } catch { fail('YIDA_OWNER_HTTP_UNAVAILABLE') } }
function sendError(res: Response, error: unknown) {
  const code = ownErrors.get(error as object) ?? yidaOwnerRuntimeErrorCode(error) ?? yidaSendApprovalErrorCode(error)
  const initializationCode = yidaInitializationErrorCode(error)
  const initializationStatus: Readonly<Record<string, number>> = { INPUT: 400, DENIED: 403, CONFLICT: 409, CANCELLED: 409,
    INACTIVE: 503, UNAVAILABLE: 503 }
  const initialSuffix = initializationCode?.replace(/^YIDA_INITIALIZATION_/u, '')
  const isInitialization = initialSuffix !== undefined && Object.hasOwn(initializationStatus, initialSuffix)
  const safe = isInitialization ? initializationCode! : code !== undefined && Object.hasOwn(statuses, code) ? code : 'YIDA_OWNER_HTTP_UNAVAILABLE'
  if (!res.writableEnded && !res.destroyed) res.status(isInitialization ? initializationStatus[initialSuffix!] : statuses[safe]).json({ ok: false, error: { code: safe } })
}
export const yidaOwnerNoStoreMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
}
export const yidaOwnerJsonOnlyMiddleware: RequestHandler = (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    res.status(415).json({ ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } })
    return
  }
  next()
}
export const yidaOwnerParseErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.writableEnded && !res.destroyed) res.destroy()
    return
  }
  let status = 503
  if (error && typeof error === 'object' && !types.isProxy(error)) {
    const supplied = Object.getOwnPropertyDescriptor(error, 'type')?.value
    if (supplied === 'entity.too.large') status = 413
    else if (supplied === 'entity.parse.failed' || supplied === 'request.aborted' || supplied === 'request.size.invalid') status = 400
    else if (supplied === 'charset.unsupported' || supplied === 'encoding.unsupported') status = 415
  }
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json({ ok: false, error: { code: status === 503 ? 'YIDA_OWNER_HTTP_UNAVAILABLE' : 'YIDA_OWNER_HTTP_INPUT' } })
}
export { YIDA_OWNER_HTTP_PREFIX } from '../integration/yida-owner-http-observation'
export function createIntegrationYidaOwnerRouter(port: YidaOwnerHttpPort, initializationPort?: YidaInitializationHttpPort): Router {
  const router = Router()
  const route = (status: number, operation: (req: Request, owner: YidaOwnerActor, signal: AbortSignal) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const controller = new AbortController()
      const aborted = () => controller.abort()
      const closed = () => { if (!res.writableEnded) controller.abort() }
      req.once('aborted', aborted); res.once('close', closed)
      if (req.aborted || res.destroyed) controller.abort()
      try {
        const owner = actor(req)
        empty(req.query)
        const data = await operation(req, owner, controller.signal)
        if (!res.writableEnded && !res.destroyed) res.status(status).json({ ok: true, data })
      } catch (error) { sendError(res, error) }
      finally { req.removeListener('aborted', aborted); res.removeListener('close', closed) }
    }
  router.post('/drafts', route(201, async (req, owner) => {
    const input = record(req.body, ['config', 'rowsText', 'allocation'])
    if (typeof input.rowsText !== 'string' || Buffer.byteLength(input.rowsText, 'utf8') > 128 * 1024) fail()
    const result = await port.prepareDraft(owner, { config: input.config, rowsText: input.rowsText, allocation: input.allocation })
    return dto(() => draft(result))
  }))
  router.post('/preview', route(200, async (req, owner) => {
    const input = record(req.body, ['operationId', 'rowKey'])
    const result = await port.preview(owner, { operationId: id(input.operationId), rowKey: id(input.rowKey) })
    return dto(() => preview(result))
  }))
  router.post('/approvals', route(201, async (req, owner) => {
    const input = record(req.body, ['operationId', 'rowKey', 'confirmationId', 'acknowledgeOnce'], ['ttlMs'])
    if (input.acknowledgeOnce !== true) fail()
    const result = await port.approve(owner, { operationId: id(input.operationId), rowKey: id(input.rowKey),
      confirmationId: id(input.confirmationId), ...(Object.hasOwn(input, 'ttlMs') ? { ttlMs: integer(input.ttlMs, 1, 900000) } : {}) })
    return dto(() => metadata(result, true))
  }))
  router.get('/approvals/:grantId', route(200, async (req, owner) => {
    empty(req.body)
    const result = await port.observe(owner, { grantId: id(req.params.grantId) })
    return dto(() => observation(result))
  }))
  router.post('/approvals/:grantId/revoke', route(200, async (req, owner) => {
    empty(req.body)
    const result = await port.revoke(owner, { grantId: id(req.params.grantId) })
    return dto(() => metadata(result, true))
  }))
  router.post('/submissions', route(200, async (req, owner, signal) => {
    const input = record(req.body, ['grantId', 'submissionId'])
    const result = await port.submit(owner, { grantId: id(input.grantId), submissionId: id(input.submissionId) }, { signal })
    return dto(() => submission(result))
  }))
  router.get('/initialization', route(200, async (req, owner, signal) => {
    empty(req.body)
    if (!initializationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.status(owner, { signal })
    return dto(() => initialization(result))
  }))
  router.post('/initialization', route(201, async (req, owner, signal) => {
    const input = initializationInput(req.body)
    if (!initializationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.initialize(owner, input, { signal })
    return dto(() => initialization(result))
  }))
  router.use((_req, res) => { res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } }) })
  return router
}
