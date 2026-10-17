import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import type { createAutomationReadLedger } from '../integration/automation-read-ledger'
import { AUTOMATION_READ_OPTION_NAME_MAX, type createAutomationReadDiscovery } from '../integration/automation-read-discovery'
import type { AutomationIntegrationActor } from '../integration/automation-live-authority'
import { checkedReadScheduleDefinition } from '../integration/automation-read-schedule-activation'
import { checkedReadDateFieldConfirmation } from '../integration/automation-read-date-schedule'
import { canonicalReadId, checkedReadBudget, checkedReadPreview, checkedReadSelector, checkedReadTriggers, checkedReadRecordCondition,
  type ReadGrantInput, type ReadRecordActivationInput, type ReadScheduleActivationInput,
  type ReadScheduleActivationRef, type ReadRetryInput, type ReadRetryRef } from '../integration/automation-read-contracts'

/** Host owner controls only. No executor, source reader, transaction or plugin
 * capability belongs on this HTTP port. Mount AFTER the real JWT middleware. */
export type AutomationReadOwnerPort = Pick<ReturnType<typeof createAutomationReadLedger>,
  'grant' | 'activateRecord' | 'submit' | 'observe' | 'cancel' | 'revoke' | 'grantDetail' | 'listGrants' | 'listRequests' | 'retryContext'>
  & Pick<ReturnType<typeof createAutomationReadDiscovery>, 'options'>
  & {
    activateSchedule(actor: AutomationIntegrationActor, input: ReadScheduleActivationInput): Promise<ReadScheduleActivationRef>
    retry(actor: AutomationIntegrationActor, parentRequestId: string, input: ReadRetryInput): Promise<ReadRetryRef>
  }
type Data = Record<string, unknown>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const requestStates = new Set(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])
const scopeHeaders = new Set(['tenant', 'tenantid', 'workspace', 'workspaceid', 'org', 'orgid',
  'organization', 'organizationid', 'scope', 'managementscope', 'principal', 'principalid',
  'actor', 'actorid', 'owner', 'ownerid', 'user', 'userid', 'projectid', 'projectno',
  'actas', 'onbehalfof', 'impersonate', 'impersonation'])
const statuses: Readonly<Record<string, number>> = Object.freeze({
  UNAUTHORIZED: 401,
  AUTOMATION_READ_INPUT_INVALID: 400,
  AUTOMATION_READ_DENIED: 403,
  AUTOMATION_READ_SCOPE_CHANGED: 409,
  AUTOMATION_READ_BUDGET_EXHAUSTED: 409,
  AUTOMATION_READ_IDEMPOTENCY_CONFLICT: 409,
  AUTOMATION_READ_FENCE_LOST: 409,
  AUTOMATION_READ_ROUTING_UNAVAILABLE: 503,
  AUTOMATION_READ_TRANSACTION_REQUIRED: 503,
  AUTOMATION_READ_UNAVAILABLE: 503,
  AUTOMATION_READ_RUNTIME_INACTIVE: 503,
  AUTOMATION_ACTOR_INPUT_INVALID: 400,
  AUTOMATION_ACTOR_TRANSACTION_REQUIRED: 503,
  AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE: 503,
  AUTOMATION_ACTOR_AUTHORITY_DENIED: 403,
})
const inputErrorStatuses: Readonly<Record<string, number>> = Object.freeze({
  'entity.parse.failed': 400,
  'request.aborted': 400,
  'request.size.invalid': 400,
  'entity.too.large': 413,
  'charset.unsupported': 415,
  'encoding.unsupported': 415,
})
function fail(code = 'AUTOMATION_READ_INPUT_INVALID'): never {
  throw Object.assign(new Error(code), { code })
}
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail()
  const names = Reflect.ownKeys(value)
  if (names.some(key => typeof key !== 'string' || (!keys.includes(key) && !optional.includes(key)))
    || keys.some(key => !Object.hasOwn(value, key))) fail()
  const result: Data = {}
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    result[key as string] = descriptor.value
  }
  return result
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail()
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    return descriptor.value
  })
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail()
  return value
}
function canonical(value: unknown): string {
  if (!canonicalReadId(value)) fail()
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
  return value
}
function integer(value: unknown, minimum: number, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail()
  return value as number
}
function selector(value: unknown) {
  return checkedReadSelector(object(value, ['ruleId', 'actionId', 'systemId', 'targetId']))
}
function budget(value: unknown) {
  return checkedReadBudget(object(value, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
}
function projects(value: unknown): string[] {
  const values = array(value, 256).map(canonical)
  if (values.length === 0 || new Set(values).size !== values.length) fail()
  return values
}
function grantInput(value: unknown): ReadGrantInput {
  const input = object(value, ['selector', 'projects', 'triggers', 'budget', 'expiresAt', 'maxExecutions'])
  return { selector: selector(input.selector), projects: projects(input.projects),
    triggers: [...checkedReadTriggers(array(input.triggers, 3))], budget: budget(input.budget),
    expiresAt: timestamp(input.expiresAt), maxExecutions: integer(input.maxExecutions, 1) }
}
function retryInput(value: unknown): ReadRetryInput {
  const input = object(value, ['retryKey', 'budget', 'expiresAt', 'acknowledgeNewRead'])
  if (input.acknowledgeNewRead !== true) fail()
  return { retryKey: id(input.retryKey), budget: budget(input.budget), expiresAt: timestamp(input.expiresAt),
    acknowledgeNewRead: true }
}
function activationScopeInput(value: unknown): Omit<ReadScheduleActivationInput, 'expectedRuleRevision'> {
  const input = object(value, ['activationKey', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions'])
  return { activationKey: id(input.activationKey), selector: selector(input.selector), projectNo: canonical(input.projectNo),
    budget: budget(input.budget), expiresAt: timestamp(input.expiresAt), maxExecutions: integer(input.maxExecutions, 1) }
}
function scheduleActivationInput(value: unknown): ReadScheduleActivationInput {
  const input = object(value, ['activationKey', 'expectedRuleRevision', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions'], ['expectedDateField'])
  const { expectedRuleRevision, expectedDateField, ...scope } = input
  return { ...activationScopeInput(scope), expectedRuleRevision: id(expectedRuleRevision),
    ...(Object.hasOwn(input, 'expectedDateField') ? { expectedDateField: checkedReadDateFieldConfirmation(expectedDateField) } : {}) }
}
function recordActivationInput(value: unknown): ReadRecordActivationInput {
  const input = object(value, ['activationKey', 'expectedRuleRevision', 'expectedRecordCondition', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions'])
  const { expectedRuleRevision, expectedRecordCondition, ...scope } = input
  return { ...activationScopeInput(scope), expectedRuleRevision: id(expectedRuleRevision),
    expectedRecordCondition: checkedReadRecordCondition(expectedRecordCondition) }
}
function actor(req: Request): AutomationIntegrationActor {
  // AuthService returns a canonical User.id. Do not adopt sub/userId aliases,
  // role/permission claims, header fallback user.tenantId, or tenant ALS.
  if (!canonicalReadId(req.user?.id)) fail('UNAUTHORIZED')
  if (!canonicalReadId(req.authenticatedTenantId)) fail('AUTOMATION_READ_DENIED')
  for (const header of Object.keys(req.headers)) {
    const name = header.toLowerCase().replace(/^x-/, '').replace(/[-_]/gu, '')
    if (scopeHeaders.has(name)) fail()
  }
  return Object.freeze({ actorId: req.user.id, tenantId: req.authenticatedTenantId, workspaceId: null })
}
function pageInput(req: Request, requests: boolean) {
  const query = object(req.query ?? {}, [], requests ? ['limit', 'after', 'grantId'] : ['limit', 'after'])
  const output: { limit?: number; after?: string; grantId?: string } = {}
  if (Object.hasOwn(query, 'limit')) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/u.test(query.limit)) fail()
    output.limit = integer(Number(query.limit), 1, 50)
  }
  if (Object.hasOwn(query, 'after')) output.after = id(query.after)
  if (Object.hasOwn(query, 'grantId')) output.grantId = id(query.grantId)
  return output
}
function empty(value: unknown): void { object(value === undefined ? {} : value, []) }
function optionsInput(req: Request) {
  const query = object(req.query ?? {}, ['sheetId'], ['limit', 'after'])
  const result: { sheetId: string; limit?: number; after?: string } = { sheetId: canonical(query.sheetId) }
  if (Object.hasOwn(query, 'limit')) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/u.test(query.limit)) fail()
    result.limit = integer(Number(query.limit), 1, 50)
  }
  if (Object.hasOwn(query, 'after')) result.after = canonical(query.after)
  return result
}
function optionsPage(value: unknown) {
  const row = object(value, ['items', 'nextCursor'])
  const items = array(row.items, 50).map(value => {
    const item = object(value, ['selector', 'ruleName', 'budget', 'allowedTriggers', 'recordActivationEligible', 'scheduleActivationEligible', 'recordTriggerType', 'recordRuleRevision', 'recordCondition', 'scheduleRuleRevision', 'scheduleDefinition'])
    if (typeof item.ruleName !== 'string' || item.ruleName.length > AUTOMATION_READ_OPTION_NAME_MAX) fail()
    const allowedTriggers = [...checkedReadTriggers(array(item.allowedTriggers, 3))]
    if (typeof item.recordActivationEligible !== 'boolean' || (item.recordActivationEligible && !allowedTriggers.includes('record'))) fail()
    if (item.recordTriggerType !== null && item.recordTriggerType !== 'record.created' && item.recordTriggerType !== 'record.updated') fail()
    if (item.recordActivationEligible !== (item.recordTriggerType !== null)) fail()
    const recordRuleRevision = item.recordRuleRevision === null ? null : id(item.recordRuleRevision)
    if (item.recordActivationEligible !== (recordRuleRevision !== null)) fail()
    const recordCondition = item.recordCondition === null ? null : checkedReadRecordCondition(item.recordCondition)
    if (item.recordActivationEligible !== (recordCondition !== null)) fail()
    if (typeof item.scheduleActivationEligible !== 'boolean' || (item.scheduleActivationEligible && !allowedTriggers.includes('schedule'))
      || (item.recordActivationEligible && item.scheduleActivationEligible)) fail()
    const scheduleRuleRevision = item.scheduleRuleRevision === null ? null : id(item.scheduleRuleRevision)
    let scheduleDefinition = null
    if (item.scheduleDefinition !== null) {
      const raw = object(item.scheduleDefinition, ['triggerType'], ['config', 'intervalMs', 'anchorMs', 'dateField'])
      if (raw.triggerType === 'schedule.cron') {
        const shape = object(raw, ['triggerType', 'config'])
        scheduleDefinition = checkedReadScheduleDefinition(shape.triggerType, shape.config, null)
      } else if (raw.triggerType === 'schedule.date_field') {
        const shape = object(raw, ['triggerType', 'config', 'dateField'])
        scheduleDefinition = checkedReadScheduleDefinition(shape.triggerType, shape.config, null, shape.dateField)
      } else {
        const shape = object(raw, ['triggerType', 'intervalMs', 'anchorMs'])
        scheduleDefinition = checkedReadScheduleDefinition(shape.triggerType,
          { intervalMs: integer(shape.intervalMs, 1000) }, integer(shape.anchorMs, 1, 8640000000000000))
      }
    }
    if (item.scheduleActivationEligible !== (scheduleRuleRevision !== null)
      || item.scheduleActivationEligible !== (scheduleDefinition !== null)) fail()
    return { selector: selector(item.selector), ruleName: item.ruleName, budget: budget(item.budget),
      allowedTriggers, recordActivationEligible: item.recordActivationEligible, scheduleActivationEligible: item.scheduleActivationEligible,
      recordTriggerType: item.recordTriggerType, recordRuleRevision, recordCondition, scheduleRuleRevision, scheduleDefinition }
  })
  const nextCursor = row.nextCursor === null ? null : canonical(row.nextCursor)
  if (new Set(items.map(item => item.selector.ruleId)).size !== items.length
    || (nextCursor !== null && nextCursor !== items.at(-1)?.selector.ruleId)) fail()
  return { items, nextCursor }
}
function requestRef(value: unknown, result = false) {
  const row = object(value, result ? ['requestId', 'status', 'result'] : ['requestId', 'status'])
  if (typeof row.status !== 'string' || !requestStates.has(row.status)) fail()
  const ref = { requestId: id(row.requestId), status: row.status }
  if (!result) return ref
  if (row.result === null) return { ...ref, result: null }
  if (row.status !== 'succeeded') fail()
  const preview = object(row.result, ['status', 'counts', 'canApply'])
  return { ...ref, result: checkedReadPreview({ ...preview,
    counts: object(preview.counts, ['add', 'update', 'skip', 'inactive', 'manual_confirm']) }) }
}
function grantDetail(value: unknown) {
  const row = object(value, ['grantId', 'purpose', 'status', 'selector', 'projects', 'triggers', 'budget',
    'expiresAt', 'maxExecutions', 'usedExecutions', 'createdAt', 'updatedAt'])
  if (row.status !== 'active' && row.status !== 'revoked') fail()
  if (row.purpose !== 'standalone' && row.purpose !== 'automatic' && row.purpose !== 'retry') fail()
  const grantProjects = projects(row.projects), grantTriggers = [...checkedReadTriggers(array(row.triggers, 3))]
  if (row.purpose === 'automatic' && (grantProjects.length !== 1 || grantTriggers.length !== 1
    || !['record', 'schedule'].includes(grantTriggers[0]))) fail()
  const maxExecutions = integer(row.maxExecutions, 1)
  if (row.purpose === 'retry' && (grantProjects.length !== 1 || grantTriggers.length !== 1
    || !['manual', 'schedule'].includes(grantTriggers[0]) || maxExecutions !== 1)) fail()
  return { grantId: id(row.grantId), purpose: row.purpose, status: row.status, selector: selector(row.selector), projects: grantProjects,
    triggers: grantTriggers, budget: budget(row.budget), expiresAt: timestamp(row.expiresAt),
    maxExecutions, usedExecutions: integer(row.usedExecutions, 0, maxExecutions),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }
}
function requestSummary(value: unknown) {
  const row = object(value, ['requestId', 'grantId', 'status', 'projectNo', 'trigger', 'createdAt', 'startedAt', 'finishedAt'])
  if (typeof row.status !== 'string' || !requestStates.has(row.status)
    || typeof row.trigger !== 'string' || !['manual', 'schedule', 'record'].includes(row.trigger)) fail()
  return { requestId: id(row.requestId), grantId: id(row.grantId), status: row.status, projectNo: canonical(row.projectNo),
    trigger: row.trigger, createdAt: timestamp(row.createdAt), startedAt: row.startedAt === null ? null : timestamp(row.startedAt),
    finishedAt: row.finishedAt === null ? null : timestamp(row.finishedAt) }
}
function retryRef(value: unknown, parentRequestId: string) {
  const row = object(value, ['parentRequestId', 'grantId', 'requestId', 'status'])
  const request = requestRef({ requestId: row.requestId, status: row.status })
  if (id(row.parentRequestId) !== parentRequestId || request.requestId === parentRequestId) fail()
  return { parentRequestId, grantId: id(row.grantId), ...request }
}
function retryContext(value: unknown, parentRequestId: string) {
  const row = object(value, ['request', 'grant', 'nextAttempt'], ['dateScheduleOrigin'])
  const request = requestSummary(row.request), grant = grantDetail(row.grant)
  if (request.requestId !== parentRequestId || request.grantId !== grant.grantId
    || !grant.projects.includes(request.projectNo) || !grant.triggers.includes(request.trigger as 'manual' | 'record' | 'schedule')) fail()
  let dateScheduleOrigin
  if (Object.hasOwn(row, 'dateScheduleOrigin')) {
    const origin = object(row.dateScheduleOrigin, ['definition', 'ruleRevision'])
    const shape = object(origin.definition, ['triggerType', 'config', 'dateField'])
    const definition = checkedReadScheduleDefinition(shape.triggerType, shape.config, null, shape.dateField)
    if (definition.triggerType !== 'schedule.date_field' || request.trigger !== 'schedule'
      || !['automatic', 'retry'].includes(grant.purpose)
      || grant.triggers.length !== 1 || grant.triggers[0] !== 'schedule') fail()
    dateScheduleOrigin = { definition, ruleRevision: id(origin.ruleRevision) }
  }
  // This is historical origin metadata, never a promise of current eligibility.
  // A schedule retry cannot be represented without its original date definition.
  if (grant.purpose === 'retry' && request.trigger === 'schedule' && !dateScheduleOrigin) fail()
  let nextAttempt = null
  if (row.nextAttempt !== null) {
    const next = object(row.nextAttempt, ['requestId', 'grantId'])
    nextAttempt = { requestId: id(next.requestId), grantId: id(next.grantId) }
    if (nextAttempt.requestId === parentRequestId || nextAttempt.grantId === grant.grantId) fail()
  }
  return { request, grant, nextAttempt, ...(dateScheduleOrigin ? { dateScheduleOrigin } : {}) }
}
function page(value: unknown, item: (value: unknown) => unknown) {
  const row = object(value, ['items', 'nextCursor'])
  return { items: array(row.items, 50).map(item), nextCursor: row.nextCursor === null ? null : id(row.nextCursor) }
}
function dto(project: () => unknown): unknown {
  try { return project() } catch { return fail('AUTOMATION_READ_UNAVAILABLE') }
}
function sendError(res: Response, error: unknown): void {
  let code = 'AUTOMATION_READ_UNAVAILABLE'
  try {
    if (error && typeof error === 'object') {
      const supplied = Object.getOwnPropertyDescriptor(error, 'code')?.value
      if (typeof supplied === 'string' && Object.hasOwn(statuses, supplied)) code = supplied
    }
  } catch { /* Even error inspection must not expose arbitrary provider details. */ }
  res.status(statuses[code]).json({ ok: false, error: { code } })
}

/** Mount only at /api/integration/automation-read, BEFORE JSON parsing and JWT,
 * so even their early refusals cannot cache an owner API response. */
export const automationReadNoStoreMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
}

/** Mount at the SAME exact path prefix AFTER the router. This is the terminal
 * owner boundary, including failures before a route runs. Never forward an
 * arbitrary exception to the host's general logger or error serializer. */
export const automationReadParseErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    // A partial response cannot be replaced with JSON. Close without passing
    // the exception to the socket, logging hooks, or another error middleware.
    if (!res.writableEnded && !res.destroyed) res.destroy()
    return
  }
  let type: unknown, status: unknown
  try {
    if (error && typeof error === 'object') {
      const ownType = Object.getOwnPropertyDescriptor(error, 'type')?.value
      const ownStatus = Object.getOwnPropertyDescriptor(error, 'status')?.value
      type = ownType
      status = ownStatus
    }
  } catch { /* Inspection failures receive the same fixed unavailable response. */ }
  // body-parser's http-errors subclasses inherit their status. Match their
  // own fixed type without traversing arbitrary exception prototypes/getters.
  const inputStatus = status === 400 || status === 413 || status === 415
    ? status : typeof type === 'string' && Object.hasOwn(inputErrorStatuses, type) ? inputErrorStatuses[type] : null
  res.setHeader('Cache-Control', 'no-store')
  res.status(inputStatus ?? 503).json({ ok: false, error: {
    code: inputStatus === null ? 'AUTOMATION_READ_UNAVAILABLE' : 'AUTOMATION_READ_INPUT_INVALID',
  } })
}

export function createIntegrationAutomationReadRouter(port: AutomationReadOwnerPort): Router {
  const router = Router()
  const route = (status: number, operation: (req: Request, actor: AutomationIntegrationActor) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const owner = actor(req)
        const data = await operation(req, owner)
        res.status(status).json({ ok: true, data })
      } catch (error) { sendError(res, error) }
    }
  router.get('/options', route(200, async (req, owner) => {
    empty(req.body)
    const result = await port.options(owner, optionsInput(req))
    return dto(() => optionsPage(result))
  }))
  router.post('/grants', route(201, async (req, owner) => {
    empty(req.query)
    const result = await port.grant(owner, grantInput(req.body))
    return dto(() => ({ grantId: id(object(result, ['grantId']).grantId) }))
  }))
  router.post('/record-activations', route(201, async (req, owner) => {
    empty(req.query)
    const result = await port.activateRecord(owner, recordActivationInput(req.body))
    return dto(() => {
      const row = object(result, ['activationId', 'grantId'])
      return { activationId: id(row.activationId), grantId: id(row.grantId) }
    })
  }))
  router.post('/schedule-activations', route(201, async (req, owner) => {
    empty(req.query)
    // Closed owner command; optional date metadata is confirmation, not a
    // trigger selector or occurrence. The actual locked DB rule selects family.
    const result = await port.activateSchedule(owner, scheduleActivationInput(req.body))
    return dto(() => {
      const row = object(result, ['activationId', 'grantId'])
      return { activationId: id(row.activationId), grantId: id(row.grantId) }
    })
  }))
  router.get('/grants', route(200, async (req, owner) => {
    empty(req.body)
    const result = await port.listGrants(owner, pageInput(req, false))
    return dto(() => page(result, grantDetail))
  }))
  router.get('/grants/:id', route(200, async (req, owner) => {
    empty(req.query); empty(req.body)
    const result = await port.grantDetail(owner, id(req.params.id))
    return dto(() => grantDetail(result))
  }))
  router.post('/grants/:id/revoke', route(200, async (req, owner) => {
    empty(req.query); empty(req.body)
    const result = await port.revoke(owner, id(req.params.id))
    return dto(() => {
      const row = object(result, ['grantId', 'status'])
      if (row.status !== 'revoked') fail()
      return { grantId: id(row.grantId), status: 'revoked' }
    })
  }))
  router.post('/requests', route(202, async (req, owner) => {
    empty(req.query)
    const input = object(req.body, ['grantId', 'invocationId', 'projectNo'])
    const result = await port.submit(owner, { grantId: id(input.grantId), invocationId: canonical(input.invocationId),
      projectNo: canonical(input.projectNo), trigger: 'manual' })
    return dto(() => requestRef(result))
  }))
  router.get('/requests', route(200, async (req, owner) => {
    empty(req.body)
    const result = await port.listRequests(owner, pageInput(req, true))
    return dto(() => page(result, requestSummary))
  }))
  router.get('/requests/:id', route(200, async (req, owner) => {
    empty(req.query); empty(req.body)
    const result = await port.observe(owner, id(req.params.id))
    return dto(() => requestRef(result, true))
  }))
  router.post('/requests/:id/cancel', route(200, async (req, owner) => {
    empty(req.query); empty(req.body)
    const result = await port.cancel(owner, id(req.params.id))
    return dto(() => requestRef(result))
  }))
  router.get('/requests/:id/retry-context', route(200, async (req, owner) => {
    empty(req.query); empty(req.body)
    const parentRequestId = id(req.params.id)
    const result = await port.retryContext(owner, parentRequestId)
    return dto(() => retryContext(result, parentRequestId))
  }))
  router.post('/requests/:id/retry', route(202, async (req, owner) => {
    empty(req.query)
    const parentRequestId = id(req.params.id)
    const result = await port.retry(owner, parentRequestId, retryInput(req.body))
    return dto(() => retryRef(result, parentRequestId))
  }))
  // Router is mount-relative and must be mounted ONLY at its dedicated prefix.
  // No matching owner endpoint/method means no dispatch and a closed response.
  router.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
  })
  return router
}
