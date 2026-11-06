import { types } from 'node:util'
import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { yidaOwnerRuntimeErrorCode, type createYidaOwnerRuntime, type YidaOwnerActor } from '../integration/yida-owner-runtime'
import { yidaSendApprovalErrorCode } from '../integration/yida-send-approval-service'
import { yidaInitializationErrorCode, type YidaInitializationInput } from '../integration/yida-initialization-runtime'
import { yidaConnectionTestErrorCode, type YidaConnectionTestInput } from '../integration/yida-connection-test-runtime'
import { yidaReconciliationErrorCode, type YidaReconciliationInput } from '../integration/yida-reconciliation-runtime'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../integration/yida-owner-http-observation'
import { YIDA_SEND_REQUEST_MAX_BYTES } from '../integration/yida-send-budget'
import {
  parseYidaSheetSourceInput, readYidaSheetSourceRows, yidaSheetSourceErrorCode, type YidaSheetSourceBinding,
  type YidaSheetSourceDependencies,
} from '../integration/yida-sheet-source'

/** Dedicated host owner boundary, after actual JWT. Never a communication API.
 * Preview values belong only to this authorized no-store response, not logs. */
export type YidaOwnerHttpPort = Pick<ReturnType<typeof createYidaOwnerRuntime>,
  'prepareDraft' | 'preview' | 'approve' | 'revoke' | 'observe' | 'submit' | 'sendEnabled'>
  & Partial<Pick<ReturnType<typeof createYidaOwnerRuntime>, 'multiTargetEnabled' | 'proveDraftOwner'>>
export type YidaInitializationHttpPort = Readonly<{
  status(actor: YidaOwnerActor, options: { signal: AbortSignal }): Promise<unknown>
  initialize(actor: YidaOwnerActor, input: YidaInitializationInput, options: { signal: AbortSignal }): Promise<unknown>
  // Y2 (INTEGRATION_YIDA_MULTI_TARGET_ENABLED exact 'true' only): the anchor owner's targets.
  targets?(actor: YidaOwnerActor, options: { signal: AbortSignal }): Promise<unknown>
  registerTarget?(actor: YidaOwnerActor, input: YidaInitializationInput, options: { signal: AbortSignal }): Promise<unknown>
}>
/** Owner-run token-only 测试连接 (ADR adr-yida-connection-test-20261028); never send authority. */
export type YidaConnectionTestHttpPort = Readonly<{
  test(actor: YidaOwnerActor, input: YidaConnectionTestInput, options: { signal: AbortSignal }): Promise<unknown>
  connectionTestEnabled(): boolean
}>
/** R-71 ⑦.5 cut-over reconciliation (INTEGRATION_YIDA_RECONCILE_READ_ENABLED exact 'true' only): read-only
 * paginated search + local insert-only evidence; never send authority. */
export type YidaReconciliationHttpPort = Readonly<{
  step(actor: YidaOwnerActor, input: YidaReconciliationInput, options: { signal: AbortSignal }): Promise<unknown>
  inspect(actor: YidaOwnerActor, input: { runId: string }, options: { signal: AbortSignal }): Promise<unknown>
  reconcileEnabled(): boolean
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
  // Gate 4 (R-71 ⑦.2): the row exceeds the shared send budget; refused before any grant/admission.
  YIDA_SEND_APPROVAL_LIMIT: 422,
  // Identity fence (design baseline v2.3 §3.3, D16): this material row's logical creation identity (key value +
  // project) was already created under this target; nothing new is created. Refused at approval, before a grant.
  YIDA_SEND_APPROVAL_IDENTITY_RESERVED: 409,
  YIDA_CONNECTION_TEST_INPUT: 400, YIDA_CONNECTION_TEST_DISABLED: 403, YIDA_CONNECTION_TEST_DENIED: 403,
  YIDA_CONNECTION_TEST_CONFLICT: 409, YIDA_CONNECTION_TEST_CANCELLED: 409, YIDA_CONNECTION_TEST_THROTTLED: 429,
  YIDA_CONNECTION_TEST_INACTIVE: 503, YIDA_CONNECTION_TEST_UNAVAILABLE: 503,
  // Y2 sheet/view source (multi-target switch ON only). Values-free fixed codes.
  YIDA_SHEET_SOURCE_INPUT: 400, YIDA_SHEET_SOURCE_DENIED: 403, YIDA_SHEET_SOURCE_NOT_FOUND: 404,
  YIDA_SHEET_SOURCE_LIMIT: 422, YIDA_SHEET_SOURCE_UNSUPPORTED: 422, YIDA_SHEET_SOURCE_UNAVAILABLE: 503,
  // R-71 ⑦.5 cut-over reconciliation (its own switch). Values-free fixed codes.
  YIDA_RECONCILE_INPUT: 400, YIDA_RECONCILE_DISABLED: 403, YIDA_RECONCILE_DENIED: 403, YIDA_RECONCILE_NOT_FOUND: 404,
  YIDA_RECONCILE_CONFLICT: 409, YIDA_RECONCILE_CANCELLED: 409, YIDA_RECONCILE_INACTIVE: 503, YIDA_RECONCILE_UNAVAILABLE: 503,
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
// Pasted credential text (appKey/appSecret/systemToken/userId). The connection test exchanges it and L4
// seals it for good, byte for byte, so it is refused here, before any port, transaction, exchange, crypto
// or write, when it has surrounding whitespace (a pasted line break) or holds, anywhere, a control character
// (Cc: C0, DEL, C1), an invisible format character (Cf: zero-width, bidi, BOM, soft hyphen) or a lone
// surrogate (Cs). Never trimmed: an API caller learns its input was wrong (the panel trims before sending).
function credential(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) fail()
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
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > YIDA_SEND_REQUEST_MAX_BYTES) fail()
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
// Y2 target picker DTO: slot 1 first, ascending slots, owner-authorized no-store reply only.
function targetSummaries(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) fail()
  let previous = 0
  return value.map(item => {
    const row = record(item, ['slot', 'targetRef', 'appType', 'formUuid'])
    const slot = integer(row.slot, previous + 1, 16)
    if (previous === 0 && slot !== 1) fail()
    previous = slot
    return { slot, targetRef: id(row.targetRef), appType: literalId(row.appType), formUuid: literalId(row.formUuid) }
  })
}
function targetsView(value: unknown) {
  const row = record(value, ['targets', 'registered', 'canSend', 'tokenIssued', 'externalWriteAttempted'])
  if (row.canSend !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false) fail()
  const targets = targetSummaries(row.targets)
  let registered = null
  if (row.registered !== null) {
    const made = record(row.registered, ['commandId', 'slot', 'targetRef', 'draft'])
    registered = { commandId: id(made.commandId), slot: integer(made.slot, 2, 16), targetRef: id(made.targetRef), draft: draft(made.draft) }
    if (!targets.some(target => target.targetRef === registered!.targetRef && target.slot === registered!.slot)) fail()
  }
  return { targets, registered, canSend: false, tokenIssued: false, externalWriteAttempted: false }
}
function initializationInput(value: unknown) {
  const parsed = record(value, ['commandId', 'material', 'draft', 'attestation'])
  const material = record(parsed.material, ['appKey', 'appSecret', 'systemToken', 'userId'])
  for (const key of Object.keys(material)) credential(material[key], key === 'userId' ? 128 : 4096)
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
function connectionTestInput(value: unknown) {
  const parsed = record(value, ['commandId', 'mode', 'material'])
  if (parsed.mode !== 'candidate') fail()
  const material = record(parsed.material, ['appKey', 'appSecret'])
  for (const key of Object.keys(material)) credential(material[key], 4096)
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > 16 * 1024) fail()
  return { commandId: id(parsed.commandId), mode: 'candidate' as const,
    material: { appKey: material.appKey as string, appSecret: material.appSecret as string } }
}
const connectionTestOutcomes = ['ok', 'upstream_rejected', 'unreachable', 'timeout']
function connectionTestView(value: unknown, commandId: string) {
  const row = record(value, ['commandId', 'mode', 'outcome', 'tokenIssued', 'tokenRetained', 'externalWriteAttempted', 'canSend'])
  if (id(row.commandId) !== commandId || row.mode !== 'candidate' || typeof row.outcome !== 'string'
    || !connectionTestOutcomes.includes(row.outcome) || row.tokenIssued !== (row.outcome === 'ok')
    || row.tokenRetained !== false || row.externalWriteAttempted !== false || row.canSend !== false) fail()
  return { commandId, mode: 'candidate', outcome: row.outcome, tokenIssued: row.outcome === 'ok',
    tokenRetained: false, externalWriteAttempted: false, canSend: false }
}
function initialization(value: unknown, sendEnabled: boolean, connectionTestEnabled: boolean, multiTargetEnabled = false,
  reconcileEnabled = false) {
  const row = record(value, ['commandId', 'status', 'draft', 'canSend', 'tokenIssued', 'externalWriteAttempted'])
  if (!['ready', 'initialized'].includes(String(row.status)) || row.canSend !== false
    || row.tokenIssued !== false || row.externalWriteAttempted !== false
    || (row.status === 'ready') !== (row.draft === null)) fail()
  return { commandId: id(row.commandId), status: row.status,
    draft: row.draft === null ? null : draft(row.draft), canSend: false, tokenIssued: false, externalWriteAttempted: false, sendEnabled,
    // Present only while the switch reads exact 'true'. While OFF the key is absent, so a page still
    // running an older bundle (closed key set without it) keeps working on this backend.
    ...(connectionTestEnabled ? { connectionTestEnabled: true as const } : {}),
    // Y2: same absent-while-OFF rule, so an older bundle keeps its closed key set while the switch is off.
    ...(multiTargetEnabled ? { multiTargetEnabled: true as const } : {}),
    // R-71 ⑦.5: same absent-while-OFF rule.
    ...(reconcileEnabled ? { reconcileEnabled: true as const } : {}) }
}
const reconcileCountKeys = ['scanned', 'registered', 'would_register', 'already_reconciled', 'duplicate_remote',
  'own_acknowledged', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch',
  'key_unmatchable']
const reconcileErrorCodes: unknown[] = [null, 'RETRY', 'THROTTLED', 'RESPONSE', 'TOO_LARGE', 'UNAVAILABLE', 'ABORTED', 'BUDGET', 'TOTAL_CHANGED']
function reconcileInput(value: unknown, multiTarget: boolean): YidaReconciliationInput {
  const input = record(value, ['commandId', 'mode', 'projectNo', 'projectKeyTarget', 'expectedKeyTargets'],
    multiTarget ? ['targetRef', 'pageSize', 'pagesPerStep'] : ['pageSize', 'pagesPerStep'])
  if (typeof input.commandId !== 'string' || !UUID.test(input.commandId)) fail()
  if (input.mode !== 'count' && input.mode !== 'register') fail()
  const projectNo = literalId(input.projectNo)
  if (projectNo.length > 64) fail()
  const targets = input.expectedKeyTargets
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 32) fail()
  return { commandId: input.commandId, mode: input.mode, projectNo, projectKeyTarget: literalId(input.projectKeyTarget),
    expectedKeyTargets: targets.map((target: unknown) => literalId(target)),
    ...(Object.hasOwn(input, 'targetRef') ? { targetRef: literalId(input.targetRef) } : {}),
    ...(Object.hasOwn(input, 'pageSize') ? { pageSize: integer(input.pageSize, 1, 100) } : {}),
    ...(Object.hasOwn(input, 'pagesPerStep') ? { pagesPerStep: integer(input.pagesPerStep, 1, 10) } : {}) }
}
function reconcileView(value: unknown, runId?: string) {
  const row = record(value, ['runId', 'commandId', 'targetRef', 'mode', 'status', 'nextPageNumber', 'pagesDone', 'totalCountFirst',
    'totalCountLast', 'counts', 'lastErrorCode', 'tokenIssued', 'canSend', 'externalWriteAttempted', 'businessVerified',
    'historyVerified', 'formOwnershipVerified'])
  const counts = record(row.counts, reconcileCountKeys)
  if (typeof row.runId !== 'string' || !UUID.test(row.runId) || (runId !== undefined && row.runId !== runId)
    || typeof row.commandId !== 'string' || !UUID.test(row.commandId) || !['count', 'register'].includes(row.mode as string)
    || !['running', 'completed', 'failed'].includes(row.status as string) || typeof row.tokenIssued !== 'boolean'
    || !reconcileErrorCodes.includes(row.lastErrorCode)
    || [row.canSend, row.externalWriteAttempted, row.businessVerified, row.historyVerified, row.formOwnershipVerified]
      .some(bit => bit !== false)) fail()
  const total = (entry: unknown) => entry === null ? null : integer(entry, 0, 60000)
  return { runId: row.runId, commandId: row.commandId, targetRef: literalId(row.targetRef), mode: row.mode, status: row.status,
    nextPageNumber: integer(row.nextPageNumber, 1, 601), pagesDone: integer(row.pagesDone, 0, 600),
    totalCountFirst: total(row.totalCountFirst), totalCountLast: total(row.totalCountLast),
    counts: Object.fromEntries(reconcileCountKeys.map(key => [key, integer(counts[key], 0, 60000)])),
    lastErrorCode: row.lastErrorCode, tokenIssued: row.tokenIssued, canSend: false, externalWriteAttempted: false,
    businessVerified: false, historyVerified: false, formOwnershipVerified: false }
}
function dto(project: () => unknown) { try { return project() } catch { fail('YIDA_OWNER_HTTP_UNAVAILABLE') } }
function sendError(res: Response, error: unknown) {
  const code = ownErrors.get(error as object) ?? yidaOwnerRuntimeErrorCode(error) ?? yidaSendApprovalErrorCode(error)
    ?? yidaConnectionTestErrorCode(error) ?? yidaSheetSourceErrorCode(error) ?? yidaReconciliationErrorCode(error)
  const initializationCode = yidaInitializationErrorCode(error)
  // ENCRYPTION_NOT_READY is 503 like INACTIVE/UNAVAILABLE: a host-configuration readiness refusal,
  // not a conflict with the slot's state (409 here means CONFLICT/CANCELLED of the command).
  const initializationStatus: Readonly<Record<string, number>> = { INPUT: 400, DENIED: 403, CONFLICT: 409, CANCELLED: 409,
    INACTIVE: 503, UNAVAILABLE: 503, ENCRYPTION_NOT_READY: 503, DISABLED: 403 }
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
export function createIntegrationYidaOwnerRouter(port: YidaOwnerHttpPort, initializationPort?: YidaInitializationHttpPort,
  connectionTestPort?: YidaConnectionTestHttpPort, sheetSource?: YidaSheetSourceDependencies,
  reconciliationPort?: YidaReconciliationHttpPort): Router {
  const router = Router()
  // Y2 shape bit, read per request (exact 'true' in the owner runtime). OFF = every body below keeps its
  // original closed key set and the new paths fall through to the same 404 as any unknown path.
  const multiTargetEnabled = () => { try { return port.multiTargetEnabled?.() === true } catch { return false } }
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
    if (!multiTargetEnabled()) {
      const input = record(req.body, ['config', 'rowsText', 'allocation'])
      if (typeof input.rowsText !== 'string' || Buffer.byteLength(input.rowsText, 'utf8') > 128 * 1024) fail()
      const result = await port.prepareDraft(owner, { config: input.config, rowsText: input.rowsText, allocation: input.allocation })
      return dto(() => draft(result))
    }
    // Y2 (switch ON): a named target, and either pasted rowsText or a sheet/view source (never both).
    const input = record(req.body, ['config', 'allocation'], ['rowsText', 'source', 'targetRef'])
    if (Object.hasOwn(input, 'rowsText') === Object.hasOwn(input, 'source')) fail()
    const targetRef = Object.hasOwn(input, 'targetRef') ? id(input.targetRef) : undefined
    let rowsText: string
    // Source binding (design baseline v2.3 §7.2): only the server-side sheet read can produce one; a pasted body
    // never carries it (the closed body above has no such key), so a pasted draft is always unbound.
    let sourceBinding: YidaSheetSourceBinding | undefined
    if (Object.hasOwn(input, 'rowsText')) {
      if (typeof input.rowsText !== 'string' || Buffer.byteLength(input.rowsText, 'utf8') > 128 * 1024) fail()
      rowsText = input.rowsText
    } else {
      if (!sheetSource) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
      // Drafts need the send switch anyway: while it is off, do not read the sheet at all.
      if (!sendEnabled()) fail('YIDA_OWNER_RUNTIME_DISABLED')
      const source = parseYidaSheetSourceInput(input.source) // pure shape check, no read
      // Owner/target proof BEFORE any sheet or view read: a non-owner (or an unknown target) gets prepareDraft's
      // own refusal and the sheet is never touched. prepareDraft below proves it all again.
      if (!port.proveDraftOwner) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
      await port.proveDraftOwner(owner, targetRef === undefined ? {} : { targetRef })
      // The owner's own multitable read (this request's actor), never an elevated or plugin read.
      const read = await readYidaSheetSourceRows(req, source, sheetSource)
      rowsText = read.rowsText
      sourceBinding = read.binding
    }
    const result = await port.prepareDraft(owner, { config: input.config, rowsText, allocation: input.allocation,
      ...(targetRef === undefined ? {} : { targetRef }), ...(sourceBinding === undefined ? {} : { sourceBinding }) })
    return dto(() => draft(result))
  }))
  router.post('/preview', route(200, async (req, owner) => {
    const multi = multiTargetEnabled()
    const input = record(req.body, ['operationId', 'rowKey'], multi ? ['targetRef'] : [])
    const result = await port.preview(owner, { operationId: id(input.operationId), rowKey: id(input.rowKey),
      ...(Object.hasOwn(input, 'targetRef') ? { targetRef: id(input.targetRef) } : {}) })
    return dto(() => preview(result))
  }))
  router.post('/approvals', route(201, async (req, owner) => {
    const multi = multiTargetEnabled()
    const input = record(req.body, ['operationId', 'rowKey', 'confirmationId', 'acknowledgeOnce'], multi ? ['ttlMs', 'targetRef'] : ['ttlMs'])
    if (input.acknowledgeOnce !== true) fail()
    const result = await port.approve(owner, { operationId: id(input.operationId), rowKey: id(input.rowKey),
      confirmationId: id(input.confirmationId), ...(Object.hasOwn(input, 'ttlMs') ? { ttlMs: integer(input.ttlMs, 1, 900000) } : {}),
      ...(Object.hasOwn(input, 'targetRef') ? { targetRef: id(input.targetRef) } : {}) })
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
  // Read only after the initialization port authorized this owner + live admin,
  // so the UI may show the send entry; a display bit, never send authority.
  const sendEnabled = () => { try { return port.sendEnabled() === true } catch { return false } }
  // Same rule for the 测试连接 display bit: shown only on an owner-authorized reply, never authority.
  const connectionTestEnabled = () => { try { return connectionTestPort?.connectionTestEnabled() === true } catch { return false } }
  // R-71 ⑦.5 display bit and route gate: read per request (exact 'true' in the reconciliation runtime).
  const reconcileEnabled = () => { try { return reconciliationPort?.reconcileEnabled() === true } catch { return false } }
  router.get('/initialization', route(200, async (req, owner, signal) => {
    empty(req.body)
    if (!initializationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.status(owner, { signal })
    return dto(() => initialization(result, sendEnabled(), connectionTestEnabled(), multiTargetEnabled(), reconcileEnabled()))
  }))
  router.post('/initialization', route(201, async (req, owner, signal) => {
    const input = initializationInput(req.body)
    if (!initializationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.initialize(owner, input, { signal })
    return dto(() => initialization(result, sendEnabled(), connectionTestEnabled(), multiTargetEnabled(), reconcileEnabled()))
  }))
  // Y2: list / register additional targets. While OFF these fall through to the generic 404 below.
  const whenMultiTarget = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    if (!multiTargetEnabled()) { next(); return }
    return handler(req, res, next)
  }
  router.get('/targets', whenMultiTarget(route(200, async (req, owner, signal) => {
    empty(req.body)
    if (!initializationPort?.targets) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.targets(owner, { signal })
    return dto(() => targetsView(result))
  })))
  router.post('/targets', whenMultiTarget(route(201, async (req, owner, signal) => {
    // Same closed body as initialization: its own material, draft and owner-reviewed attestation.
    const input = initializationInput(req.body)
    if (!initializationPort?.registerTarget) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await initializationPort.registerTarget(owner, input, { signal })
    return dto(() => targetsView(result))
  })))
  // Owner-run token-only connection test before initialization. The runtime authorizes; the route
  // only closes the body and the DTO. No send authority, no form IO, nothing persisted.
  router.post('/initialization/connection-test', route(200, async (req, owner, signal) => {
    const input = connectionTestInput(req.body)
    if (!connectionTestPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await connectionTestPort.test(owner, input, { signal })
    return dto(() => connectionTestView(result, input.commandId))
  }))
  // R-71 ⑦.5 cut-over reconciliation. While its switch is OFF both paths fall through to the generic 404 below
  // (a feature that is off is not visible); the runtime checks the switch again (DISABLED) as depth.
  const whenReconcile = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    if (!reconcileEnabled()) { next(); return }
    return handler(req, res, next)
  }
  router.post('/reconciliations', whenReconcile(route(200, async (req, owner, signal) => {
    const input = reconcileInput(req.body, multiTargetEnabled())
    if (!reconciliationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await reconciliationPort.step(owner, input, { signal })
    return dto(() => reconcileView(result))
  })))
  router.get('/reconciliations/:runId', whenReconcile(route(200, async (req, owner, signal) => {
    empty(req.body)
    const runId = req.params.runId
    if (typeof runId !== 'string' || !UUID.test(runId)) fail()
    if (!reconciliationPort) fail('YIDA_OWNER_HTTP_UNAVAILABLE')
    const result = await reconciliationPort.inspect(owner, { runId }, { signal })
    return dto(() => reconcileView(result, runId))
  })))
  router.use((_req, res) => { res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } }) })
  return router
}
