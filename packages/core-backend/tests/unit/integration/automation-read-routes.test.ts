/** Router-only contract checks with a narrow stub port. These tests do not
 * prove JWT verification, live authorization, durable history or source IO. */
import { createServer, request as httpRequest } from 'node:http'
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { automationReadNoStoreMiddleware, automationReadParseErrorHandler,
  createIntegrationAutomationReadRouter, type AutomationReadOwnerPort } from '../../../src/routes/integration-automation-read'

const grantId = '00000000-0000-4000-8000-000000000001'
const requestId = '00000000-0000-4000-8000-000000000002'
const childGrantId = '00000000-0000-4000-8000-000000000003'
const childRequestId = '00000000-0000-4000-8000-000000000004'
const retryKey = '00000000-0000-4000-8000-000000000005'
const ruleRevision = '11111111-1111-4111-8111-111111111111'
const at = '2026-10-01T01:02:03.000Z'
const owner = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const input = () => ({ selector: { ruleId: 'synthetic-rule', actionId: 'plm.stock-preparation.pull-bom.v1',
  systemId: 'synthetic-system', targetId: 'synthetic-target' }, projects: ['synthetic-project'],
  triggers: ['manual'], budget: { maxRows: 100, maxPages: 5, maxReadCount: 8, timeoutMs: 60000 },
  expiresAt: at, maxExecutions: 1 })
const detail = () => ({ ...input(), grantId, purpose: 'standalone' as const, status: 'active' as const, usedExecutions: 0, createdAt: at, updatedAt: at })
const option = () => ({ selector: input().selector, ruleName: 'Synthetic preview', budget: input().budget,
  allowedTriggers: ['manual', 'record'], recordActivationEligible: true, scheduleActivationEligible: false,
  recordTriggerType: 'record.created' as 'record.created' | 'record.updated' | null, recordRuleRevision: ruleRevision as string | null,
  recordCondition: { mode: 'unconditional' as const }, scheduleRuleRevision: null as string | null,
  scheduleDefinition: null as null | { triggerType: 'schedule.cron'; config: { expression: string } } })
const summary = () => ({ requestId, grantId, status: 'queued' as const, projectNo: 'synthetic-project',
  trigger: 'manual' as const, createdAt: at, startedAt: null, finishedAt: null })
const submit = () => ({ grantId, invocationId: 'synthetic-invocation', projectNo: 'synthetic-project' })
const retry = () => ({ retryKey, budget: input().budget, expiresAt: at, acknowledgeNewRead: true as const })
const retryReceipt = () => ({ parentRequestId: requestId, grantId: childGrantId, requestId: childRequestId, status: 'queued' as const })
const retryContext = () => ({ request: summary(), grant: detail(), nextAttempt: null })
const dateRetryOrigin = () => ({ definition: { triggerType: 'schedule.date_field' as const,
  config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after' as const },
  dateField: { fieldId: 'synthetic-date', fieldType: 'dateTime' as const, schemaRevision: ruleRevision } }, ruleRevision })
const activation = () => ({ activationKey: requestId, expectedRuleRevision: ruleRevision, selector: input().selector, projectNo: 'synthetic-project',
  budget: input().budget, expiresAt: at, maxExecutions: 1 })
const recordActivation = () => ({ ...activation(), expectedRuleRevision: ruleRevision, expectedRecordCondition: { mode: 'unconditional' as const } })
const preview = { status: 'ready' as const, counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false as const }
function fixture() {
  const port = {
    options: vi.fn().mockResolvedValue({ items: [option()], nextCursor: null }),
    grant: vi.fn().mockResolvedValue({ grantId }),
    activateRecord: vi.fn().mockResolvedValue({ activationId: requestId, grantId }),
    activateSchedule: vi.fn().mockResolvedValue({ activationId: requestId, grantId }),
    grantDetail: vi.fn().mockResolvedValue(detail()),
    listGrants: vi.fn().mockResolvedValue({ items: [detail()], nextCursor: null }),
    submit: vi.fn().mockResolvedValue({ requestId, status: 'queued' }),
    listRequests: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
    observe: vi.fn().mockResolvedValue({ requestId, status: 'succeeded', result: preview }),
    cancel: vi.fn().mockResolvedValue({ requestId, status: 'cancelled' }),
    revoke: vi.fn().mockResolvedValue({ grantId, status: 'revoked' }),
    retryContext: vi.fn().mockResolvedValue(retryContext()),
    retry: vi.fn().mockResolvedValue(retryReceipt()),
  } satisfies AutomationReadOwnerPort
  const router = createIntegrationAutomationReadRouter(port)
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{
    handle(req: Request, res: Response): Promise<void>
  }> } }
  const stack = (router as unknown as { stack: Layer[] }).stack
  async function call(method: string, path: string, patch: Record<string, unknown> = {}) {
    const layer = stack.find(item => item.route?.path === path && item.route.methods[method])
    if (!layer?.route) throw new Error('Missing actual router registration')
    const state = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown }
    const req = { headers: {}, query: {}, params: { id: path.startsWith('/grants') ? grantId : requestId },
      user: { id: owner.actorId, tenantId: 'untrusted-carried-tenant' }, authenticatedTenantId: owner.tenantId,
      ...patch } as unknown as Request
    const res = { setHeader(name: string, value: string) { state.headers[name] = value },
      status(status: number) { state.status = status; return this },
      json(body: unknown) { state.body = JSON.parse(JSON.stringify(body)); return this },
    } as unknown as Response
    expect(layer.route.stack).toHaveLength(1)
    await layer.route.stack[0].handle(req, res)
    expect(state.headers['Cache-Control']).toBe('no-store')
    return state
  }
  return { port, call, stack }
}
const prefix = '/api/integration/automation-read'
type HttpReply = { status: number; body: unknown; cacheControl: string | undefined }
/** Actual Express parsing/matching/error dispatch over this test's own loopback
 * server. Identity and the ledger port remain synthetic, not JWT/DB evidence. */
async function withHttp(
  run: (http: {
    request(method: string, path: string, body?: string, headers?: Record<string, string>): Promise<HttpReply>
    port: ReturnType<typeof fixture>['port']
    hostError: ReturnType<typeof vi.fn>
  }) => Promise<void>,
  before?: RequestHandler,
  bodyLimit = 128,
): Promise<void> {
  const { port } = fixture(), app = express(), hostError = vi.fn()
  app.use(prefix, automationReadNoStoreMiddleware)
  app.use(express.json({ limit: bodyLimit }))
  if (before) app.use(prefix, before)
  app.use(prefix, (req, _res, next) => {
    req.user = { id: owner.actorId } as Request['user']
    req.authenticatedTenantId = owner.tenantId
    next()
  })
  app.use(prefix, createIntegrationAutomationReadRouter(port))
  app.use(prefix, automationReadParseErrorHandler)
  const fallback: ErrorRequestHandler = (error, _req, res, _next) => {
    hostError(error)
    res.status(500).json({ unexpectedHostHandler: true })
  }
  app.use(fallback)
  const server = createServer(app)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_HTTP_LISTENER_UNAVAILABLE')
    await run({ port, hostError, request: (method, path, body, headers = {}) => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: `${prefix}${path}`, method,
        headers: { 'content-type': 'application/json', connection: 'close', ...headers }, agent: false }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.once('error', reject)
        res.once('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            cacheControl: res.headers['cache-control'] }) } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.setTimeout(5_000, () => req.destroy(new Error('SYNTHETIC_HTTP_TIMEOUT')))
      req.end(body)
    }) })
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}
const operations = [
  ['get', '/options', 'options', 200, () => ({ query: { sheetId: 'synthetic-sheet' } })],
  ['post', '/grants', 'grant', 201, () => ({ body: input() })],
  ['post', '/record-activations', 'activateRecord', 201, () => ({ body: recordActivation() })],
  ['post', '/schedule-activations', 'activateSchedule', 201, () => ({ body: activation() })],
  ['get', '/grants', 'listGrants', 200, () => ({})],
  ['get', '/grants/:id', 'grantDetail', 200, () => ({})],
  ['post', '/grants/:id/revoke', 'revoke', 200, () => ({})],
  ['post', '/requests', 'submit', 202, () => ({ body: submit() })],
  ['get', '/requests', 'listRequests', 200, () => ({})],
  ['get', '/requests/:id', 'observe', 200, () => ({})],
  ['post', '/requests/:id/cancel', 'cancel', 200, () => ({})],
  ['get', '/requests/:id/retry-context', 'retryContext', 200, () => ({})],
  ['post', '/requests/:id/retry', 'retry', 202, () => ({ body: retry() })],
] as const

describe('Automation read owner router: strict transport, synthetic narrow port only', () => {
  const savedCondition = { mode: 'saved_conditions' as const, schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai' }
  it('transports only closed values-free condition consent on options and record activation, not schedule', async () => {
    const f = fixture(), item = { ...option(), recordCondition: savedCondition }
    f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
    const options = await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })
    expect(options).toMatchObject({ status: 200, body: { data: { items: [item] } } })
    const body = { ...recordActivation(), expectedRecordCondition: savedCondition }
    expect(await f.call('post', '/record-activations', { body })).toMatchObject({ status: 201 })
    expect(f.port.activateRecord).toHaveBeenCalledWith(owner, body)
    expect(f.port.activateRecord.mock.calls[0][1].expectedRecordCondition).not.toBe(savedCondition)
    expect(await f.call('post', '/schedule-activations', { body: { ...activation(), expectedRecordCondition: savedCondition } })).toMatchObject({ status: 400 })
    expect(f.port.activateSchedule).not.toHaveBeenCalled()
  })
  it('rejects absent, inconsistent or private condition DTOs without invoking hooks or the activation port', async () => {
    const f = fixture(), getter = vi.fn(() => 'saved_conditions')
    const invalid = [undefined, null, {}, { mode: 'unknown' }, { mode: 'unconditional', schemaRevision: ruleRevision },
      { ...savedCondition, schemaRevision: 'not-uuid' }, { ...savedCondition, businessTimeZone: 'Invalid/Zone' },
      { ...savedCondition, businessTimeZone: ' UTC ' }, { ...savedCondition, ast: { value: 'private-literal' } },
      { ...savedCondition, fingerprint: 'a'.repeat(64) }, Object.create(savedCondition),
      Object.defineProperty({ ...savedCondition }, 'mode', { enumerable: true, get: getter }),
      { ...savedCondition, [Symbol('private')]: true }]
    for (const descriptor of invalid) {
      expect(await f.call('post', '/record-activations', { body: { ...recordActivation(), expectedRecordCondition: descriptor } })).toMatchObject({ status: 400 })
      f.port.options.mockResolvedValueOnce({ items: [{ ...option(), recordCondition: descriptor }], nextCursor: null })
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503 })
    }
    const missing = recordActivation(); Reflect.deleteProperty(missing, 'expectedRecordCondition')
    expect(await f.call('post', '/record-activations', { body: missing })).toMatchObject({ status: 400 })
    const missingOption = option(); Reflect.deleteProperty(missingOption, 'recordCondition')
    f.port.options.mockResolvedValueOnce({ items: [missingOption], nextCursor: null })
    expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503 })
    f.port.options.mockResolvedValueOnce({ items: [{ ...option(), recordActivationEligible: false,
      recordRuleRevision: null, recordTriggerType: null }], nextCursor: null })
    expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503 })
    expect(getter).not.toHaveBeenCalled(); expect(f.port.activateRecord).not.toHaveBeenCalled()
  })
  it('registers only the thirteen owner endpoints, including the explicit linked retry pair and no execute alias', () => {
    const f = fixture()
    expect(f.stack.filter(layer => layer.route).map(layer => ({ path: layer.route?.path, methods: Object.keys(layer.route?.methods ?? {}) })))
      .toEqual(operations.map(([method, path]) => ({ path, methods: [method] })))
  })
  for (const [method, path, name, status, patch] of operations) {
    it(`${method} ${path} passes only the trusted actor with explicit null workspace`, async () => {
      const f = fixture()
      const response = await f.call(method, path, patch())
      expect(response.status).toBe(status)
      expect(response.body).toMatchObject({ ok: true })
      expect(f.port[name]).toHaveBeenCalledTimes(1)
      const actor = f.port[name].mock.calls[0][0]
      expect(actor).toEqual(owner)
      expect(Object.hasOwn(actor, 'workspaceId')).toBe(true)
      expect(Object.isFrozen(actor)).toBe(true)
      for (const [key, fn] of Object.entries(f.port)) if (key !== name) expect(fn).not.toHaveBeenCalled()
    })
    it(`${method} ${path} rejects missing identity, scope query/body pollution and tenant headers before the port`, async () => {
      const f = fixture()
      const cases = [
        [{ ...patch(), user: undefined }, 401, 'UNAUTHORIZED'],
        [{ ...patch(), user: { sub: owner.actorId, userId: owner.actorId } }, 401, 'UNAUTHORIZED'],
        [{ ...patch(), authenticatedTenantId: undefined, user: { id: owner.actorId, tenantId: owner.tenantId },
          headers: { 'x-tenant-id': owner.tenantId } }, 403, 'AUTOMATION_READ_DENIED'],
        [{ ...patch(), query: { tenantId: owner.tenantId } }, 400, 'AUTOMATION_READ_INPUT_INVALID'],
        [{ ...patch(), body: { ...((patch() as { body?: object }).body ?? {}), workspaceId: null } }, 400, 'AUTOMATION_READ_INPUT_INVALID'],
        [{ ...patch(), headers: { 'x-tenant-id': owner.tenantId } }, 400, 'AUTOMATION_READ_INPUT_INVALID'],
      ] as const
      for (const [overrides, expectedStatus, code] of cases) {
        expect(await f.call(method, path, overrides)).toMatchObject({ status: expectedStatus, body: { ok: false, error: { code } } })
      }
      for (const fn of Object.values(f.port)) expect(fn).not.toHaveBeenCalled()
    })
  }
  it('submits exactly grantId/invocationId/projectNo with server-fixed manual trigger', async () => {
    const f = fixture()
    expect(await f.call('post', '/requests', { body: submit() })).toMatchObject({ status: 202,
      body: { ok: true, data: { requestId, status: 'queued' } } })
    expect(f.port.submit).toHaveBeenCalledWith(owner, { ...submit(), trigger: 'manual' })
    for (const extra of [{ trigger: 'schedule' }, { trigger: 'manual' }, { actorId: owner.actorId },
      { sourceReference: {} }, { authorityKey: 'synthetic-private' }, { proof: {} }, { retry: true }]) {
      const rejected = await f.call('post', '/requests', { body: { ...submit(), ...extra } })
      // A status-only oracle could hide execution followed by a late refusal.
      expect(f.port.submit.mock.calls.slice(1)).toEqual([])
      expect(rejected).toMatchObject({ status: 400 })
    }
    expect(f.port.submit).toHaveBeenCalledTimes(1)
  })
  it('retry passes a detached four-field consent and path-only parent, never grants or submits through another port', async () => {
    const f = fixture(), body = retry()
    expect(await f.call('post', '/requests/:id/retry', { body })).toMatchObject({ status: 202,
      body: { ok: true, data: retryReceipt() } })
    expect(f.port.retry).toHaveBeenCalledTimes(1)
    expect(f.port.retry).toHaveBeenCalledWith(owner, requestId, body)
    expect(f.port.retry.mock.calls[0][2]).not.toBe(body)
    expect(f.port.retry.mock.calls[0][2].budget).not.toBe(body.budget)
    expect(Object.keys(f.port.retry.mock.calls[0][2]).sort()).toEqual(['acknowledgeNewRead', 'budget', 'expiresAt', 'retryKey'])
    for (const [name, port] of Object.entries(f.port)) if (name !== 'retry') expect(port).not.toHaveBeenCalled()
  })
  it.each(['retryKey', 'budget', 'expiresAt', 'acknowledgeNewRead'] as const)('retry refuses missing required %s before dispatch', async field => {
    const f = fixture(), body = retry(); Reflect.deleteProperty(body, field)
    expect(await f.call('post', '/requests/:id/retry', { body })).toMatchObject({ status: 400,
      body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
    for (const port of Object.values(f.port)) expect(port).not.toHaveBeenCalled()
  })
  it('retry refuses false-ish acknowledgement, noncanonical primitives and all caller-supplied identity or execution material', async () => {
    const f = fixture()
    const invalid = [
      ...[false, undefined, null, 'true', 'false', 1, 0, [], {}].map(acknowledgeNewRead => ({ ...retry(), acknowledgeNewRead })),
      ...['', 'not-uuid', retryKey + ' ', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 1].map(retryKey => ({ ...retry(), retryKey })),
      ...['2026-10-01', null, 0, 'invalid'].map(expiresAt => ({ ...retry(), expiresAt })),
      { ...retry(), budget: { ...input().budget, maxRows: 0 } }, { ...retry(), budget: { ...input().budget, proof: {} } },
      ...[{ parentRequestId: requestId }, { grantId }, { requestId }, { selector: input().selector }, { projectNo: 'synthetic-project' },
        { trigger: 'manual' }, { purpose: 'retry' }, { maxExecutions: 1 }, { actorId: owner.actorId }, { tenantId: owner.tenantId },
        { workspaceId: null }, { sourceReference: {} }, { authorityKey: 'synthetic-private' }, { proof: {} }, { invocationId: retryKey }]
        .map(extra => ({ ...retry(), ...extra })),
    ]
    for (const body of invalid) expect(await f.call('post', '/requests/:id/retry', { body })).toMatchObject({ status: 400 })
    for (const port of Object.values(f.port)) expect(port).not.toHaveBeenCalled()
  })
  it('retry rejects nonplain, hidden, symbolic and accessor consent without executing hooks', async () => {
    const f = fixture(), getter = vi.fn(() => true), serialize = vi.fn(() => retry())
    for (const body of [undefined, null, [], 'invalid', Object.create(retry()), { ...retry(), toJSON: serialize },
      { ...retry(), [Symbol('private')]: true },
      Object.defineProperty(retry(), 'acknowledgeNewRead', { enumerable: true, get: getter }),
      Object.defineProperty(retry(), 'retryKey', { enumerable: false, value: retryKey }),
      { ...retry(), budget: Object.defineProperty(input().budget, 'maxRows', { enumerable: true, get: getter }) }]) {
      expect(await f.call('post', '/requests/:id/retry', { body })).toMatchObject({ status: 400 })
    }
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
    for (const port of Object.values(f.port)) expect(port).not.toHaveBeenCalled()
  })
  it.each(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])(
    'retry recovery preserves child status %s without interpreting 202 as completed source IO', async status => {
      const f = fixture(), receipt = { ...retryReceipt(), status }
      f.port.retry.mockResolvedValueOnce(receipt)
      expect(await f.call('post', '/requests/:id/retry', { body: retry() })).toMatchObject({ status: 202, body: { ok: true, data: receipt } })
    })
  it('retry rejects malformed, widened, self-parent and mismatched-parent receipts without private hooks', async () => {
    const f = fixture(), getter = vi.fn(() => requestId), serialize = vi.fn(() => 'synthetic-private')
    const missing = Object.keys(retryReceipt()).map(field => { const value = retryReceipt(); Reflect.deleteProperty(value, field); return value })
    for (const receipt of [null, [], ...missing, { ...retryReceipt(), parentRequestId: childRequestId },
      { ...retryReceipt(), requestId }, { ...retryReceipt(), grantId: 'invalid' }, { ...retryReceipt(), status: 'active' },
      { ...retryReceipt(), result: preview }, { ...retryReceipt(), sourceReference: 'synthetic-private' },
      { ...retryReceipt(), toJSON: serialize }, { ...retryReceipt(), [Symbol('private')]: true }, Object.create(retryReceipt()),
      Object.defineProperty(retryReceipt(), 'parentRequestId', { enumerable: true, get: getter })]) {
      f.port.retry.mockResolvedValueOnce(receipt)
      expect(await f.call('post', '/requests/:id/retry', { body: retry() })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
  })
  it.each(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])(
    'retry context observes parent status %s for every legitimate purpose/trigger without eligibility or a mutation', async status => {
      const f = fixture()
      for (const [purpose, trigger] of [['standalone', 'manual'], ['standalone', 'record'], ['standalone', 'schedule'],
        ['automatic', 'record'], ['automatic', 'schedule'], ['retry', 'manual']] as const) {
        const context = { request: { ...summary(), status, trigger }, grant: { ...detail(), purpose, triggers: [trigger] }, nextAttempt: null }
        f.port.retryContext.mockResolvedValueOnce(context)
        expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 200, body: { ok: true, data: context } })
      }
      expect(f.port.retryContext).toHaveBeenCalledTimes(6)
      for (const [name, port] of Object.entries(f.port)) if (name !== 'retryContext') expect(port).not.toHaveBeenCalled()
    })
  it('retry context returns the existing immutable child pair without executing or recovering it', async () => {
    const f = fixture(), context = { request: { ...summary(), status: 'outcome_unknown' },
      grant: { ...detail(), status: 'revoked', usedExecutions: 1, expiresAt: '2020-01-01T00:00:00.000Z' },
      nextAttempt: { requestId: childRequestId, grantId: childGrantId } }
    f.port.retryContext.mockResolvedValueOnce(context)
    expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 200, body: { ok: true, data: context } })
    expect(f.port.retryContext).toHaveBeenCalledWith(owner, requestId)
    expect(f.port.observe).not.toHaveBeenCalled(); expect(f.port.retry).not.toHaveBeenCalled()
  })
  it.each(['automatic', 'retry'] as const)('transports closed date origin for a %s schedule request without starting another read', async purpose => {
    const f = fixture(), context = { request: { ...summary(), status: 'failed', trigger: 'schedule' },
      grant: { ...detail(), purpose, triggers: ['schedule'], status: 'revoked', usedExecutions: 1 },
      nextAttempt: null, dateScheduleOrigin: dateRetryOrigin() }
    f.port.retryContext.mockResolvedValueOnce(context)
    expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 200, body: { ok: true, data: context } })
    f.port.grantDetail.mockResolvedValueOnce(context.grant)
    expect(await f.call('get', '/grants/:id')).toMatchObject({ status: 200, body: { data: context.grant } })
    expect(f.port.retry).not.toHaveBeenCalled(); expect(f.port.submit).not.toHaveBeenCalled()
  })
  it('rejects forged, incomplete or private date retry origin DTOs without executing getters', async () => {
    const f = fixture(), getter = vi.fn(() => 'private'), origin = dateRetryOrigin()
    const context = { request: { ...summary(), trigger: 'schedule' },
      grant: { ...detail(), purpose: 'retry', triggers: ['schedule'] }, nextAttempt: null }
    for (const dateScheduleOrigin of [undefined, null, {}, { ...origin, recordId: 'private' },
      { ...origin, ruleRevision: 'bad' }, { ...origin, definition: { triggerType: 'schedule.cron', config: { expression: '* * * * *' } } },
      { ...origin, definition: { ...origin.definition, occurrence: at } },
      { ...origin, definition: { ...origin.definition, dateField: { ...origin.definition.dateField, fieldId: 'different' } } },
      Object.defineProperty({ ...origin }, 'definition', { enumerable: true, get: getter })]) {
      f.port.retryContext.mockResolvedValueOnce({ ...context, dateScheduleOrigin })
      expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    for (const invalidContext of [context, { ...retryContext(), dateScheduleOrigin: origin },
      { ...context, grant: { ...context.grant, purpose: 'standalone' }, dateScheduleOrigin: origin },
      { ...context, grant: { ...context.grant, maxExecutions: 2 }, dateScheduleOrigin: origin }]) {
      f.port.retryContext.mockResolvedValueOnce(invalidContext)
      expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 503 })
    }
    expect(getter).not.toHaveBeenCalled(); expect(f.port.retry).not.toHaveBeenCalled()
  })
  it('retry context closes every nested projection and rejects relationship mismatches rather than asserting eligibility', async () => {
    const f = fixture(), getter = vi.fn(() => 'synthetic-private'), serialize = vi.fn(() => 'synthetic-private')
    const missing = Object.keys(retryContext()).map(field => { const value = retryContext(); Reflect.deleteProperty(value, field); return value })
    for (const context of [null, [], ...missing, Object.create(retryContext()), { ...retryContext(), eligible: true },
      { ...retryContext(), nextAttempt: undefined }, { ...retryContext(), nextAttempt: {} },
      { ...retryContext(), nextAttempt: { requestId: 'invalid', grantId: childGrantId } },
      { ...retryContext(), nextAttempt: { requestId: childRequestId, grantId: 'invalid' } },
      { ...retryContext(), nextAttempt: { requestId, grantId: childGrantId } },
      { ...retryContext(), nextAttempt: { requestId: childRequestId, grantId } },
      { ...retryContext(), nextAttempt: { requestId: childRequestId, grantId: childGrantId, status: 'queued' } },
      { ...retryContext(), request: { ...summary(), requestId: childRequestId } },
      { ...retryContext(), request: { ...summary(), grantId: childGrantId } },
      { ...retryContext(), request: { ...summary(), projectNo: 'other-project' } },
      { ...retryContext(), request: { ...summary(), trigger: 'record' } },
      { ...retryContext(), request: { ...summary(), result: preview } },
      { ...retryContext(), grant: { ...detail(), purpose: 'automatic' } },
      { ...retryContext(), grant: { ...detail(), sourceReference: 'synthetic-private' } },
      { ...retryContext(), grant: Object.defineProperty(detail(), 'budget', { enumerable: true, get: getter }) },
      { ...retryContext(), nextAttempt: Object.defineProperty({ requestId: childRequestId, grantId: childGrantId }, 'grantId', { enumerable: true, get: getter }) },
      Object.defineProperty(retryContext(), 'nextAttempt', { enumerable: true, get: getter }),
      { ...retryContext(), toJSON: serialize }, { ...retryContext(), [Symbol('private')]: true }]) {
      f.port.retryContext.mockResolvedValueOnce(context)
      expect(await f.call('get', '/requests/:id/retry-context')).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
  })
  const retryOperations = [['get', '/requests/:id/retry-context', 'retryContext', () => ({})],
    ['post', '/requests/:id/retry', 'retry', () => ({ body: retry() })]] as const
  it.each(retryOperations)('%s %s rejects malformed parent paths and query pollution before dispatch', async (method, path, _name, patch) => {
    const f = fixture()
    for (const id of [undefined, '', 'not-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', [requestId]]) {
      expect(await f.call(method, path, { ...patch(), params: { id } })).toMatchObject({ status: 400 })
    }
    expect(await f.call(method, path, { ...patch(), query: { retryKey } })).toMatchObject({ status: 400 })
    for (const port of Object.values(f.port)) expect(port).not.toHaveBeenCalled()
  })
  it.each(retryOperations)('%s %s exposes only fixed port failures without changing their HTTP class', async (method, path, name, patch) => {
    const f = fixture()
    for (const [code, status] of [['AUTOMATION_READ_DENIED', 403], ['AUTOMATION_READ_SCOPE_CHANGED', 409],
      ['AUTOMATION_READ_BUDGET_EXHAUSTED', 409], ['AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 409],
      ['AUTOMATION_READ_RUNTIME_INACTIVE', 503], ['AUTOMATION_READ_UNAVAILABLE', 503]] as const) {
      f.port[name].mockRejectedValueOnce(Object.assign(new Error('synthetic-private'), { code, cause: 'synthetic-private' }))
      expect(await f.call(method, path, patch())).toMatchObject({ status, body: { ok: false, error: { code } } })
    }
  })
  it('copies the closed grant input without admitting nested identity/configuration proof', async () => {
    const f = fixture(), body = input()
    await f.call('post', '/grants', { body })
    expect(f.port.grant).toHaveBeenCalledWith(owner, body)
    expect(f.port.grant.mock.calls[0][1]).not.toBe(body)
    expect(f.port.grant.mock.calls[0][1].selector).not.toBe(body.selector)
    for (const bad of [{ ...input(), tenantId: owner.tenantId }, { ...input(), principal: owner.actorId },
      { ...input(), selector: { ...body.selector, workspaceId: null } },
      { ...input(), budget: { ...body.budget, credentials: 'synthetic-private' } },
      { ...input(), sourceReference: {} }, { ...input(), config: {} }, { ...input(), authorityKey: 'synthetic-private' },
      { ...input(), purpose: 'automatic' }, { ...input(), purpose: 'retry' }]) {
      const rejected = await f.call('post', '/grants', { body: bad })
      expect(f.port.grant).toHaveBeenCalledTimes(1)
      expect(rejected).toMatchObject({ status: 400 })
    }
    expect(f.port.grant).toHaveBeenCalledTimes(1)
  })
  const activationOperations = [['/record-activations', 'activateRecord', recordActivation], ['/schedule-activations', 'activateSchedule', activation]] as const
  it.each(activationOperations)('%s accepts one bounded project and a stable key, never an existing grant or trigger override', async (path, method, makeBody) => {
    const f = fixture(), body = makeBody()
    expect(await f.call('post', path, { body })).toMatchObject({ status: 201,
      body: { ok: true, data: { activationId: requestId, grantId } } })
    expect(f.port[method]).toHaveBeenCalledWith(owner, body)
    expect(f.port[method].mock.calls[0][1]).not.toBe(body)
    expect(f.port[method].mock.calls[0][1].selector).not.toBe(body.selector)
    for (const bad of [{ ...body, grantId }, { ...body, trigger: 'schedule' }, { ...body, trigger: 'record' }, { ...body, projects: ['other'] },
      { ...body, activationKey: 'random-text' }, { ...body, projectNo: ' ' }, { ...body, maxExecutions: 0 },
      { ...body, selector: { ...body.selector, tenantId: owner.tenantId } }, { ...body, budget: { ...body.budget, proof: {} } },
      { ...body, recordActivationEligible: true }, { ...body, recordTriggerType: 'record.updated' },
      { ...body, scheduleActivationEligible: true }, { ...body, purpose: 'automatic' },
      { ...body, scheduledAtMs: 1790812860000 }, { ...body, cron: '* * * * *' }, { ...body, timezone: 'UTC' }]) {
      expect(await f.call('post', path, { body: bad })).toMatchObject({ status: 400 })
      expect(f.port[method]).toHaveBeenCalledTimes(1)
    }
    expect(f.port.grant).not.toHaveBeenCalled()
    expect(f.port.submit).not.toHaveBeenCalled()
  })
  it.each(activationOperations)('%s closes the returned pair and refuses private or extra output', async (path, method, makeBody) => {
    const f = fixture()
    for (const response of [{ activationId: requestId, grantId, authorityKey: 'synthetic-private' },
      { activationId: 'invalid', grantId }, { grantId }, { activationId: requestId, grantId, status: 'active' }]) {
      f.port[method].mockResolvedValueOnce(response as { activationId: string; grantId: string })
      expect(await f.call('post', path, { body: makeBody() })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
  })
  it.each(activationOperations)('%s refuses missing, nonplain and hooked input and output without executing hooks', async (path, method, makeBody) => {
    const f = fixture(), getter = vi.fn(() => 'synthetic-private'), serializer = vi.fn(() => ({ secret: 'synthetic-private' }))
    const missing = makeBody(); Reflect.deleteProperty(missing, 'activationKey')
    const hooked = Object.defineProperty(makeBody(), 'projectNo', { enumerable: true, get: getter })
    for (const body of [null, [], 'invalid', missing, hooked, Object.create(makeBody()), { ...makeBody(), toJSON: serializer }]) {
      expect(await f.call('post', path, { body })).toMatchObject({ status: 400 })
    }
    expect(f.port[method]).not.toHaveBeenCalled()
    for (const result of [null, [], { activationId: requestId }, { activationId: requestId, grantId: 'invalid' },
      Object.defineProperty({ activationId: requestId, grantId }, 'grantId', { enumerable: true, get: getter }),
      { activationId: requestId, grantId, toJSON: serializer }]) {
      f.port[method].mockResolvedValueOnce(result)
      expect(await f.call('post', path, { body: makeBody() })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled(); expect(serializer).not.toHaveBeenCalled()
  })
  it('record activation requires one canonical revision value before calling the port and never executes revision hooks', async () => {
    const f = fixture(), getter = vi.fn(() => ruleRevision), serialize = vi.fn(() => ruleRevision)
    const missing = recordActivation(); Reflect.deleteProperty(missing, 'expectedRuleRevision')
    const invalid = [missing,
      ...[undefined, null, '', 'not-uuid', ` ${ruleRevision}`, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 0, true, [], {}]
        .map(expectedRuleRevision => ({ ...recordActivation(), expectedRuleRevision })),
      Object.defineProperty(recordActivation(), 'expectedRuleRevision', { enumerable: true, get: getter }),
      Object.defineProperty(recordActivation(), 'expectedRuleRevision', { enumerable: false, value: ruleRevision }),
      { ...recordActivation(), expectedRuleRevision: { toJSON: serialize } },
    ]
    for (const body of invalid) {
      expect(await f.call('post', '/record-activations', { body })).toMatchObject({ status: 400,
        body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
    }
    expect(f.port.activateRecord).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
    const body = recordActivation()
    expect(await f.call('post', '/record-activations', { body })).toMatchObject({ status: 201 })
    expect(f.port.activateRecord.mock.calls).toEqual([[owner, body]])
    expect(Object.keys(f.port.activateRecord.mock.calls[0][1]).sort()).toEqual([
      'activationKey', 'budget', 'expectedRecordCondition', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector',
    ])
  })
  it('schedule activation requires its exact seven-field body and rejects the record condition field', async () => {
    const f = fixture(), body = activation()
    expect(await f.call('post', '/schedule-activations', { body })).toMatchObject({ status: 201 })
    expect(f.port.activateSchedule.mock.calls).toEqual([[owner, body]])
    expect(Object.keys(f.port.activateSchedule.mock.calls[0][1]).sort()).toEqual([
      'activationKey', 'budget', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector',
    ])
    expect(await f.call('post', '/schedule-activations', { body: recordActivation() })).toMatchObject({ status: 400 })
    expect(f.port.activateSchedule).toHaveBeenCalledTimes(1)
    expect(f.port.activateRecord).not.toHaveBeenCalled()
  })
  it.each(['x-tenant-id', 'X-TENANT-ID', 'tenant_id', 'x-workspace-id', 'x-org-id', 'x-scope',
    'x-principal', 'x-actor-id', 'x-owner-id', 'x-user-id', 'x-project-id', 'x-on-behalf-of'])(
    'rejects even an empty scope/principal header: %s', async header => {
    const f = fixture()
    expect(await f.call('get', '/requests', { headers: { [header]: '' } })).toMatchObject({ status: 400 })
    expect(f.port.listRequests).not.toHaveBeenCalled()
  })
  it('accepts only bounded canonical page parameters and no totals/result fields', async () => {
    const f = fixture()
    await f.call('get', '/grants', { query: { limit: '50', after: grantId } })
    expect(f.port.listGrants).toHaveBeenCalledWith(owner, { limit: 50, after: grantId })
    const result = await f.call('get', '/requests', { query: { limit: '1', after: requestId, grantId } })
    expect(f.port.listRequests).toHaveBeenCalledWith(owner, { limit: 1, after: requestId, grantId })
    expect(result.body).toEqual({ ok: true, data: { items: [summary()], nextCursor: null } })
    for (const query of [{ limit: '0' }, { limit: '51' }, { limit: '01' }, { limit: '1.5' }, { limit: ['1', '2'] },
      { after: 'not-an-id' }, { after: requestId.toUpperCase().replace('00000000', 'AAAAAAAA') },
      { grantId: 'bad' }, { includeResult: 'true' }, { scope: 'tenant' }]) {
      expect(await f.call('get', '/requests', { query })).toMatchObject({ status: 400 })
    }
    expect(f.port.listRequests).toHaveBeenCalledTimes(1)
    expect(await f.call('get', '/grants', { query: { grantId } })).toMatchObject({ status: 400 })
  })
  it('options accepts sheet plus bounded limit and a real rule cursor, never client source/target material', async () => {
    const f = fixture()
    const response = await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet', limit: '50', after: 'atr_rule-01' } })
    expect(response.body).toEqual({ ok: true, data: { items: [option()], nextCursor: null } })
    expect(f.port.options).toHaveBeenCalledTimes(1)
    expect(f.port.options).toHaveBeenCalledWith(owner, { sheetId: 'synthetic-sheet', limit: 50, after: 'atr_rule-01' })
    for (const query of [{}, { sheetId: '' }, { sheetId: ['synthetic-sheet'] }, { sheetId: ' padded ' },
      ...[{ limit: '0' }, { limit: '51' }, { limit: '01' }, { limit: ['1'] }, { after: '' }, { after: ['one'] },
        { targetId: 'private' }, { systemId: 'private' }, { proof: 'private' }, { tenantId: owner.tenantId }, { includeTotal: 'true' }]
        .map(extra => ({ sheetId: 'synthetic-sheet', ...extra }))]) {
      expect(await f.call('get', '/options', { query })).toMatchObject({ status: 400 })
    }
    expect(f.port.options).toHaveBeenCalledTimes(1)
  })
  it('options projects fixed fields, bounds names and refuses private material, duplicate and invalid cursors', async () => {
    const f = fixture(), getter = vi.fn(() => 'private')
    const hooked = Object.defineProperty(option(), 'ruleName', { enumerable: true, get: getter })
    for (const result of [
      { items: [{ ...option(), sourceReference: {} }], nextCursor: null },
      { items: [{ ...option(), ruleName: 'x'.repeat(161) }], nextCursor: null },
      { items: [{ ...option(), allowedTriggers: [] }], nextCursor: null },
      { items: [hooked], nextCursor: null },
      { items: [option(), option()], nextCursor: null },
      { items: [option()], nextCursor: 'different-rule' }, { items: [], nextCursor: 'synthetic-rule' },
      { items: [option()], nextCursor: null, total: 1 },
    ]) {
      f.port.options.mockResolvedValueOnce(result)
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([true, false])('options preserves explicit record activation eligibility %s as a display boolean', async recordActivationEligible => {
    const f = fixture(), item = { ...option(), recordActivationEligible,
      recordTriggerType: recordActivationEligible ? 'record.created' as const : null,
      recordRuleRevision: recordActivationEligible ? ruleRevision : null, recordCondition: recordActivationEligible ? option().recordCondition : null }
    f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
    expect((await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).body)
      .toEqual({ ok: true, data: { items: [item], nextCursor: null } })
    expect(f.port.activateRecord).not.toHaveBeenCalled()
    expect(f.port.grant).not.toHaveBeenCalled()
    expect(f.port.submit).not.toHaveBeenCalled()
  })
  it('options rejects missing, widened, nonboolean, inconsistent and accessor eligibility without invoking hooks', async () => {
    const f = fixture(), getter = vi.fn(() => true), missing = option()
    Reflect.deleteProperty(missing, 'recordActivationEligible')
    const accessor = Object.defineProperty(option(), 'recordActivationEligible', { enumerable: true, get: getter })
    const invalid = [missing, accessor, { ...option(), triggerType: 'record.created' },
      { ...option(), allowedTriggers: ['manual'] },
      ...[undefined, null, 'true', 'false', 0, 1, [], {}].map(recordActivationEligible => ({ ...option(), recordActivationEligible }))]
    for (const item of invalid) {
      f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['record.created', 'record.updated'] as const)('options displays the exact current eligible %s without making it an activation input', async recordTriggerType => {
    const f = fixture(), item = { ...option(), recordTriggerType }
    f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
    expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } }))
      .toMatchObject({ status: 200, body: { ok: true, data: { items: [item], nextCursor: null } } })
    expect(f.port.activateRecord).not.toHaveBeenCalled()
  })
  it('options fails closed on missing, unknown, hooked and eligibility-mismatched record types', async () => {
    const f = fixture(), missing = option(), getter = vi.fn(() => 'record.updated')
    Reflect.deleteProperty(missing, 'recordTriggerType')
    const invalid = [missing, Object.defineProperty(option(), 'recordTriggerType', { enumerable: true, get: getter }),
      ...[null, undefined, 'updated', 'record.deleted', 'record.updated ', 'RECORD.UPDATED', 'multitable.record.updated', false, 1, [], {}]
        .map(recordTriggerType => ({ ...option(), recordTriggerType })),
      { ...option(), recordActivationEligible: false },
      { ...option(), allowedTriggers: ['schedule'], recordTriggerType: 'record.updated' },
    ]
    for (const item of invalid) {
      f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } }))
        .toMatchObject({ status: 503, body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it('options requires a closed canonical record revision paired exactly with eligible type and policy', async () => {
    const f = fixture(), missing = option(), getter = vi.fn(() => ruleRevision), serialize = vi.fn(() => ruleRevision)
    Reflect.deleteProperty(missing, 'recordRuleRevision')
    const invalid = [missing,
      ...[undefined, null, '', 'not-uuid', ` ${ruleRevision}`, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', false, 1, [], {}]
        .map(recordRuleRevision => ({ ...option(), recordRuleRevision })),
      Object.defineProperty(option(), 'recordRuleRevision', { enumerable: true, get: getter }),
      Object.defineProperty(option(), 'recordRuleRevision', { enumerable: false, value: ruleRevision }),
      { ...option(), recordRuleRevision: { toJSON: serialize } },
      { ...option(), recordActivationEligible: false, recordTriggerType: null },
      { ...option(), allowedTriggers: ['schedule'], recordActivationEligible: false, recordTriggerType: null, scheduleActivationEligible: true },
      { ...option(), recordActivationEligible: false, recordRuleRevision: null },
      { ...option(), expectedRuleRevision: ruleRevision },
    ]
    for (const item of invalid) {
      f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
    expect(f.port.activateRecord).not.toHaveBeenCalled(); expect(f.port.activateSchedule).not.toHaveBeenCalled()
  })
  it.each([
    { allowedTriggers: ['manual'], recordActivationEligible: false, scheduleActivationEligible: false },
    { allowedTriggers: ['record', 'schedule'], recordActivationEligible: true, scheduleActivationEligible: false },
    { allowedTriggers: ['schedule'], recordActivationEligible: false, scheduleActivationEligible: true },
    { allowedTriggers: ['manual', 'schedule'], recordActivationEligible: false, scheduleActivationEligible: true },
    { allowedTriggers: ['record', 'schedule'], recordActivationEligible: false, scheduleActivationEligible: true },
    { allowedTriggers: ['record', 'schedule'], recordActivationEligible: false, scheduleActivationEligible: false },
  ])('options returns both explicit flags and the eligible schedule confirmation %#', async fields => {
    const f = fixture(), item = { ...option(), ...fields,
      recordTriggerType: fields.recordActivationEligible ? 'record.created' as const : null,
      recordRuleRevision: fields.recordActivationEligible ? ruleRevision : null, recordCondition: fields.recordActivationEligible ? option().recordCondition : null,
      scheduleRuleRevision: fields.scheduleActivationEligible ? ruleRevision : null,
      scheduleDefinition: fields.scheduleActivationEligible ? { triggerType: 'schedule.cron', config: { expression: '* * * * *' } } : null }
    f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
    const response = await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })
    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { items: [item], nextCursor: null } } })
    expect(Object.keys(item).sort()).toEqual(['allowedTriggers', 'budget', 'recordActivationEligible', 'recordCondition',
      'recordRuleRevision', 'recordTriggerType', 'ruleName', 'scheduleActivationEligible', 'scheduleDefinition', 'scheduleRuleRevision', 'selector'])
    expect(f.port.activateSchedule).not.toHaveBeenCalled(); expect(f.port.activateRecord).not.toHaveBeenCalled()
    expect(f.port.grant).not.toHaveBeenCalled(); expect(f.port.submit).not.toHaveBeenCalled()
  })
  it('options requires a boolean schedule flag with matching policy and refuses two eligible families or widened config', async () => {
    const f = fixture(), missing = option(), getter = vi.fn(() => true)
    Reflect.deleteProperty(missing, 'scheduleActivationEligible')
    const eligible = { ...option(), allowedTriggers: ['schedule'], recordActivationEligible: false, scheduleActivationEligible: true,
      recordTriggerType: null, recordRuleRevision: null, recordCondition: null,
      scheduleRuleRevision: ruleRevision, scheduleDefinition: { triggerType: 'schedule.cron', config: { expression: '* * * * *' } } }
    const accessor = Object.defineProperty({ ...eligible }, 'scheduleActivationEligible', { enumerable: true, get: getter })
    const invalid = [missing, accessor,
      ...[undefined, null, 'true', 'false', 0, 1, [], {}].map(scheduleActivationEligible => ({ ...eligible, scheduleActivationEligible })),
      ...[['manual'], ['record'], ['manual', 'record']].map(allowedTriggers => ({ ...eligible, allowedTriggers })),
      { ...eligible, allowedTriggers: ['record', 'schedule'], recordActivationEligible: true,
        recordTriggerType: 'record.created', recordRuleRevision: ruleRevision, recordCondition: option().recordCondition },
      { ...eligible, cronConfig: { expression: '* * * * *' } },
      { ...eligible, trigger_config: { expression: '* * * * *' } },
      { ...eligible, expression: '* * * * *' }, { ...eligible, timezone: 'UTC' },
    ]
    for (const item of invalid) {
      f.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
      expect(await f.call('get', '/options', { query: { sheetId: 'synthetic-sheet' } })).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled()
    expect(f.port.activateSchedule).not.toHaveBeenCalled()
  })
  it('real Express options serializes exactly both flags and rejects a pre-schedule DTO without granting or activating', async () => {
    await withHttp(async http => {
      const item = { ...option(), allowedTriggers: ['schedule'], recordActivationEligible: false, scheduleActivationEligible: true,
        recordTriggerType: null, recordRuleRevision: null, recordCondition: null,
        scheduleRuleRevision: ruleRevision, scheduleDefinition: { triggerType: 'schedule.cron', config: { expression: '* * * * *' } } }
      http.port.options.mockResolvedValueOnce({ items: [item], nextCursor: null })
      expect(await http.request('GET', '/options?sheetId=synthetic-sheet')).toEqual({ status: 200, cacheControl: 'no-store',
        body: { ok: true, data: { items: [item], nextCursor: null } } })
      const missing = { ...item }; Reflect.deleteProperty(missing, 'scheduleActivationEligible')
      http.port.options.mockResolvedValueOnce({ items: [missing], nextCursor: null })
      expect(await http.request('GET', '/options?sheetId=synthetic-sheet')).toEqual({ status: 503, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      for (const [key, fn] of Object.entries(http.port)) if (key !== 'options') expect(fn).not.toHaveBeenCalled()
      expect(http.hostError).not.toHaveBeenCalled()
    })
  })
  it.each([
    { purpose: 'standalone', triggers: ['manual'], projects: ['synthetic-project'] },
    { purpose: 'standalone', triggers: ['record'], projects: ['synthetic-project', 'synthetic-second'] },
    { purpose: 'standalone', triggers: ['schedule'], projects: ['synthetic-project', 'synthetic-second'] },
    { purpose: 'automatic', triggers: ['record'], projects: ['synthetic-project'] },
    { purpose: 'automatic', triggers: ['schedule'], projects: ['synthetic-project'] },
    { purpose: 'retry', triggers: ['manual'], projects: ['synthetic-project'] },
  ])('grant detail and history preserve explicit purpose without inferring it from triggers %#', async fields => {
    const f = fixture(), item = { ...detail(), ...fields }
    f.port.grantDetail.mockResolvedValueOnce(item)
    f.port.listGrants.mockResolvedValueOnce({ items: [item], nextCursor: null })
    expect((await f.call('get', '/grants/:id')).body).toEqual({ ok: true, data: item })
    expect((await f.call('get', '/grants')).body).toEqual({ ok: true, data: { items: [item], nextCursor: null } })
    expect(f.port.submit).not.toHaveBeenCalled()
    expect(f.port.activateRecord).not.toHaveBeenCalled()
    expect(f.port.activateSchedule).not.toHaveBeenCalled()
  })
  it('both grant projections reject missing/unknown purpose, extra fields and automatic/retry scope mismatches', async () => {
    const f = fixture(), missing = detail(), getter = vi.fn(() => 'standalone')
    Reflect.deleteProperty(missing, 'purpose')
    const accessor = Object.defineProperty(detail(), 'purpose', { enumerable: true, get: getter })
    const automatic = { ...detail(), purpose: 'automatic', triggers: ['record'] }
    const invalid = [missing, accessor,
      ...[undefined, null, 'manual', 'AUTOMATIC', true, 1, {}].map(purpose => ({ ...detail(), purpose })),
      { ...detail(), activationId: requestId },
      { ...automatic, projects: ['synthetic-project', 'synthetic-second'] },
      { ...automatic, triggers: ['manual'] }, { ...automatic, triggers: ['record', 'schedule'] },
      { ...automatic, triggers: ['schedule', 'schedule'] }, { ...automatic, triggers: ['schedule', 'manual'] },
      { ...automatic, triggers: ['schedule'], projects: ['synthetic-project', 'synthetic-second'] },
      { ...automatic, triggers: ['record', 'manual'] }, { ...automatic, triggers: ['record', 'record'] },
      { ...detail(), purpose: 'retry', projects: ['synthetic-project', 'synthetic-second'] },
      { ...detail(), purpose: 'retry', triggers: ['record'] }, { ...detail(), purpose: 'retry', triggers: ['schedule', 'manual'] },
      { ...detail(), purpose: 'retry', triggers: ['manual', 'record'] }, { ...detail(), purpose: 'retry', maxExecutions: 2 },
      { ...detail(), purpose: 'retry', usedExecutions: 2 },
    ]
    for (const item of invalid) {
      f.port.grantDetail.mockResolvedValueOnce(item)
      f.port.listGrants.mockResolvedValueOnce({ items: [item], nextCursor: null })
      for (const path of ['/grants/:id', '/grants']) {
        expect(await f.call('get', path)).toMatchObject({ status: 503,
          body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      }
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it('rejects invalid grant primitives, sparse/accessor inputs, bad IDs, and malformed bodies', async () => {
    const f = fixture(), getter = vi.fn(() => 'synthetic-private')
    const accessor = { ...input() }
    Object.defineProperty(accessor, 'expiresAt', { enumerable: true, get: getter })
    const sparse = input(); sparse.projects = new Array(1)
    for (const body of [null, [], 'invalid', { ...input(), triggers: [] }, { ...input(), triggers: ['manual', 'manual'] },
      { ...input(), projects: [] }, { ...input(), projects: ['same', 'same'] }, { ...input(), maxExecutions: 0 },
      { ...input(), expiresAt: '2026-10-01' }, { ...input(), budget: { ...input().budget, maxRows: 0 } },
      accessor, sparse, Object.create(input())]) {
      expect(await f.call('post', '/grants', { body })).toMatchObject({ status: 400 })
    }
    expect(getter).not.toHaveBeenCalled()
    for (const invalid of ['not-uuid', 'AAAAAAAA-0000-4000-8000-000000000000', undefined, ['one']]) {
      expect(await f.call('get', '/requests/:id', { params: { id: invalid } })).toMatchObject({ status: 400 })
    }
    for (const body of [{ ...submit(), invocationId: ' padded ' }, { ...submit(), projectNo: '' }, { ...submit(), grantId: 1 }]) {
      expect(await f.call('post', '/requests', { body })).toMatchObject({ status: 400 })
    }
    for (const fn of Object.values(f.port)) expect(fn).not.toHaveBeenCalled()
  })
  it('projects only observe preview counts; a private result cannot appear in lists', async () => {
    const f = fixture()
    expect((await f.call('get', '/requests/:id')).body).toEqual({ ok: true, data: { requestId, status: 'succeeded', result: preview } })
    f.port.listRequests.mockResolvedValueOnce({ items: [{ ...summary(), result: preview }], nextCursor: null })
    expect(await f.call('get', '/requests')).toMatchObject({ status: 503, body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
  })
  it('rejects widened or hook-bearing output without invoking private serializers', async () => {
    const f = fixture(), getter = vi.fn(() => 'synthetic-private')
    const bad = Object.defineProperty({ grantId }, 'private', { enumerable: true, get: getter })
    f.port.grant.mockResolvedValueOnce(bad)
    expect(await f.call('post', '/grants', { body: input() })).toMatchObject({ status: 503 })
    f.port.observe.mockResolvedValueOnce({ requestId, status: 'running', result: preview })
    expect(await f.call('get', '/requests/:id')).toMatchObject({ status: 503 })
    const serialize = vi.fn(() => ({ secret: 'synthetic-private' }))
    f.port.observe.mockResolvedValueOnce({ requestId, status: 'succeeded', result: { ...preview, toJSON: serialize } })
    expect(await f.call('get', '/requests/:id')).toMatchObject({ status: 503 })
    f.port.grantDetail.mockResolvedValueOnce({ ...detail(), sourceReference: { connectionId: 'synthetic-private' } })
    const rejected = await f.call('get', '/grants/:id')
    expect(JSON.stringify(rejected.body)).not.toContain('synthetic-private')
    expect(rejected).toMatchObject({ status: 503 })
    expect(getter).not.toHaveBeenCalled()
    expect(serialize).not.toHaveBeenCalled()
  })
  it.each([
    ['AUTOMATION_READ_INPUT_INVALID', 400], ['AUTOMATION_READ_DENIED', 403], ['AUTOMATION_READ_SCOPE_CHANGED', 409],
    ['AUTOMATION_READ_BUDGET_EXHAUSTED', 409], ['AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 409],
    ['AUTOMATION_READ_FENCE_LOST', 409], ['AUTOMATION_READ_ROUTING_UNAVAILABLE', 503],
    ['AUTOMATION_READ_TRANSACTION_REQUIRED', 503], ['AUTOMATION_READ_UNAVAILABLE', 503],
    ['AUTOMATION_READ_RUNTIME_INACTIVE', 503], ['AUTOMATION_ACTOR_AUTHORITY_DENIED', 403],
    ['AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE', 503], ['AUTOMATION_ACTOR_TRANSACTION_REQUIRED', 503],
  ])('maps only fixed error %s to HTTP %i without message/cause', async (code, status) => {
    const f = fixture()
    f.port.observe.mockRejectedValueOnce(Object.assign(new Error('synthetic-private-error'), { code, cause: { secret: 'synthetic-private' } }))
    expect(await f.call('get', '/requests/:id')).toMatchObject({ status, body: { ok: false, error: { code } } })
  })
  it('unknown, inherited, getter and proxy error codes cannot expose provider data', async () => {
    const f = fixture(), getter = vi.fn(() => 'AUTOMATION_READ_DENIED')
    for (const error of [new Error('synthetic-private'), { code: 'synthetic-private' },
      Object.create({ code: 'AUTOMATION_READ_DENIED' }), Object.defineProperty({}, 'code', { get: getter }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('synthetic-private') } })]) {
      f.port.observe.mockRejectedValueOnce(error)
      expect(await f.call('get', '/requests/:id')).toMatchObject({ status: 503,
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it('supplies no-store before parsing/auth and terminates all errors with fixed responses', () => {
    const req = {} as Request, next = vi.fn()
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }
    res.status.mockReturnValue(res)
    automationReadNoStoreMiddleware(req, res as unknown as Response, next)
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(next).toHaveBeenCalledTimes(1)
    next.mockClear()
    for (const [error, status] of [
      [{ type: 'entity.parse.failed', status: 400, body: 'synthetic-private', message: 'synthetic-private' }, 400],
      [{ type: 'entity.too.large', status: 413, message: 'synthetic-private' }, 413],
      [Object.assign(new URIError('synthetic-private'), { status: 400 }), 400],
      [{ type: 'charset.unsupported', status: 415, charset: 'synthetic-private' }, 415],
      [{ type: 'encoding.unsupported', status: 415, encoding: 'synthetic-private' }, 415],
    ] as const) {
      automationReadParseErrorHandler(error, req, res as unknown as Response, next)
      expect(res.status).toHaveBeenLastCalledWith(status)
      expect(res.json).toHaveBeenLastCalledWith({ ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } })
    }
    expect(next).not.toHaveBeenCalled()
    const error = Object.assign(new Error('synthetic-private'), { status: 500 })
    automationReadParseErrorHandler(error, req, res as unknown as Response, next)
    expect(res.status).toHaveBeenLastCalledWith(503)
    expect(res.json).toHaveBeenLastCalledWith({ ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
    expect(next).not.toHaveBeenCalled()
  })
  it('never invokes exception getters/serializers or forwards inherited/proxy errors', () => {
    const getter = vi.fn(() => 400), serialize = vi.fn(() => 'synthetic-private'), next = vi.fn()
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }
    res.status.mockReturnValue(res)
    for (const error of [Object.create({ status: 400 }), { status: '400', toJSON: serialize },
      Object.defineProperty({ toJSON: serialize }, 'status', { get: getter }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('synthetic-private') } })]) {
      automationReadParseErrorHandler(error, {} as Request, res as unknown as Response, next)
      expect(res.status).toHaveBeenLastCalledWith(503)
      expect(res.json).toHaveBeenLastCalledWith({ ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
    }
    expect(getter).not.toHaveBeenCalled()
    expect(serialize).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
  it.each([
    [{ headersSent: true, writableEnded: false, destroyed: false }, 1],
    [{ headersSent: true, writableEnded: true, destroyed: false }, 0],
    [{ headersSent: false, writableEnded: false, destroyed: true }, 0],
  ])('closes a started response without forwarding or a second write: %j', (state, destroys) => {
    const next = vi.fn(), res = { ...state, setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), destroy: vi.fn() }
    automationReadParseErrorHandler(new Error('synthetic-private'), {} as Request, res as unknown as Response, next)
    expect(res.destroy).toHaveBeenCalledTimes(destroys)
    if (destroys) expect(res.destroy).toHaveBeenCalledWith()
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
  it.each([
    ['GET', '/requests/%synthetic-private', undefined, {}, 400],
    ['GET', '/grants/%E0%A4%A', undefined, {}, 400],
    ['POST', '/requests', '{"synthetic-private":', {}, 400],
    ['POST', '/requests', JSON.stringify({ value: 'synthetic-private'.repeat(16) }), {}, 413],
    ['POST', '/requests', '{}', { 'content-type': 'application/json; charset=synthetic-private' }, 415],
    ['POST', '/requests', '{}', { 'content-encoding': 'synthetic-private' }, 415],
  ] as const)('real Express %s %s input failure is fixed and never reaches host errors', async (method, path, body, headers, status) => {
    await withHttp(async http => {
      expect(await http.request(method, path, body, headers)).toEqual({ status, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      expect(http.hostError).not.toHaveBeenCalled()
      for (const fn of Object.values(http.port)) expect(fn).not.toHaveBeenCalled()
    })
  })
  it('real Express schedule activation parses the closed body and returns only its receipt; unchanged key retries remain explicit', async () => {
    await withHttp(async http => {
      const body = activation(), wire = JSON.stringify(body)
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await http.request('POST', '/schedule-activations', wire)).toEqual({ status: 201, cacheControl: 'no-store',
          body: { ok: true, data: { activationId: requestId, grantId } } })
      }
      // Transport forwards the identical key/body, not a manufactured grant or
      // occurrence. Ledger idempotency is deliberately not claimed by this port double.
      expect(http.port.activateSchedule.mock.calls).toEqual([[owner, body], [owner, body]])
      expect(await http.request('POST', '/schedule-activations', JSON.stringify({ ...body, scheduledAtMs: 1 })))
        .toEqual({ status: 400, cacheControl: 'no-store', body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      expect(await http.request('POST', '/schedule-activations', wire, { 'x-tenant-id': owner.tenantId }))
        .toEqual({ status: 400, cacheControl: 'no-store', body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      expect(http.port.activateSchedule).toHaveBeenCalledTimes(2)
      for (const [key, fn] of Object.entries(http.port)) if (key !== 'activateSchedule') expect(fn).not.toHaveBeenCalled()
      expect(http.hostError).not.toHaveBeenCalled()
    }, undefined, 2048)
  })
  it('real Express transports closed date consent, not caller occurrence or authority', async () => {
    await withHttp(async http => {
      const expectedDateField = { fieldId: 'synthetic-date', fieldType: 'date', schemaRevision: ruleRevision }
      const body = { ...activation(), expectedDateField }, wire = JSON.stringify(body)
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await http.request('POST', '/schedule-activations', wire)).toMatchObject({ status: 201 })
      }
      expect(http.port.activateSchedule.mock.calls).toEqual([[owner, body], [owner, body]])
      for (const invalid of [null, { ...expectedDateField, fieldType: 'text' }, { ...expectedDateField, schemaRevision: 'caller' },
        { ...expectedDateField, recordId: 'caller' }, { fieldId: 'synthetic-date', fieldType: 'date' }]) {
        expect(await http.request('POST', '/schedule-activations', JSON.stringify({ ...body, expectedDateField: invalid })))
          .toMatchObject({ status: 400, body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      }
      expect(http.port.activateSchedule).toHaveBeenCalledTimes(2)
      expect(http.port.submit).not.toHaveBeenCalled(); expect(http.hostError).not.toHaveBeenCalled()
    }, undefined, 2048)
  })
  it('real Express schedule activation closes service failures and widened receipts without exposing private details', async () => {
    await withHttp(async http => {
      for (const [code, status] of [['AUTOMATION_READ_DENIED', 403], ['AUTOMATION_READ_SCOPE_CHANGED', 409],
        ['AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 409], ['AUTOMATION_READ_RUNTIME_INACTIVE', 503]] as const) {
        http.port.activateSchedule.mockRejectedValueOnce(Object.assign(new Error('synthetic-private'), { code, cause: 'synthetic-private' }))
        expect(await http.request('POST', '/schedule-activations', JSON.stringify(activation())))
          .toEqual({ status, cacheControl: 'no-store', body: { ok: false, error: { code } } })
      }
      http.port.activateSchedule.mockResolvedValueOnce({ activationId: requestId, grantId, sourceReference: 'synthetic-private' })
      expect(await http.request('POST', '/schedule-activations', JSON.stringify(activation())))
        .toEqual({ status: 503, cacheControl: 'no-store', body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      expect(http.hostError).not.toHaveBeenCalled()
    }, undefined, 2048)
  })
  it('real Express linked retry parses the exact confirmation and forwards same-key recovery without ordinary submit', async () => {
    await withHttp(async http => {
      const body = retry(), wire = JSON.stringify(body), path = `/requests/${requestId}/retry`
      expect(await http.request('GET', `/requests/${requestId}/retry-context`)).toEqual({ status: 200, cacheControl: 'no-store',
        body: { ok: true, data: retryContext() } })
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await http.request('POST', path, wire)).toEqual({ status: 202, cacheControl: 'no-store',
          body: { ok: true, data: retryReceipt() } })
      }
      // Same bytes reach the real router twice. This port double does not prove
      // one-budget durability, current authority or transaction idempotency.
      expect(http.port.retry.mock.calls).toEqual([[owner, requestId, body], [owner, requestId, body]])
      for (const invalid of [{ ...body, acknowledgeNewRead: 'true' }, { ...body, parentRequestId: requestId },
        { ...body, trigger: 'manual' }, { ...body, grantId }]) {
        expect(await http.request('POST', path, JSON.stringify(invalid))).toEqual({ status: 400, cacheControl: 'no-store',
          body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      }
      expect(http.port.retry).toHaveBeenCalledTimes(2)
      for (const [name, port] of Object.entries(http.port)) if (!['retry', 'retryContext'].includes(name)) expect(port).not.toHaveBeenCalled()
      expect(http.hostError).not.toHaveBeenCalled()
    }, undefined, 2048)
  })
  it('real Express retry pair keeps malformed URI, parse errors, refusal and private DTO failures closed', async () => {
    await withHttp(async http => {
      for (const [method, path, body] of [['GET', '/requests/%E0%A4%A/retry-context', undefined],
        ['POST', '/requests/%E0%A4%A/retry', JSON.stringify(retry())],
        ['POST', `/requests/${requestId}/retry`, '{"synthetic-private":']] as const) {
        expect(await http.request(method, path, body)).toEqual({ status: 400, cacheControl: 'no-store',
          body: { ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } } })
      }
      expect(http.port.retry).not.toHaveBeenCalled(); expect(http.port.retryContext).not.toHaveBeenCalled()
      http.port.retry.mockRejectedValueOnce(Object.assign(new Error('synthetic-private'), { code: 'AUTOMATION_READ_RUNTIME_INACTIVE' }))
      expect(await http.request('POST', `/requests/${requestId}/retry`, JSON.stringify(retry()))).toEqual({ status: 503, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_RUNTIME_INACTIVE' } } })
      http.port.retry.mockResolvedValueOnce({ ...retryReceipt(), authorityKey: 'synthetic-private' })
      expect(await http.request('POST', `/requests/${requestId}/retry`, JSON.stringify(retry()))).toEqual({ status: 503, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      http.port.retryContext.mockResolvedValueOnce({ ...retryContext(), eligible: true })
      expect(await http.request('GET', `/requests/${requestId}/retry-context`)).toEqual({ status: 503, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      expect(http.hostError).not.toHaveBeenCalled()
    }, undefined, 2048)
  })
  it('real Express closes unrelated middleware exceptions without serialization or host logging', async () => {
    const serialize = vi.fn(() => 'synthetic-private'), getter = vi.fn(() => 'synthetic-private')
    const error = Object.assign(new Error('synthetic-private'), { cause: { secret: 'synthetic-private' }, toJSON: serialize })
    Object.defineProperty(error, 'status', { get: getter })
    await withHttp(async http => {
      expect(await http.request('GET', '/requests')).toEqual({ status: 503, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } } })
      expect(http.hostError).not.toHaveBeenCalled()
      for (const fn of Object.values(http.port)) expect(fn).not.toHaveBeenCalled()
      expect(serialize).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    }, (_req, _res, next) => next(error))
  })
  it.each([401, 403])('real Express preserves normal authentication middleware HTTP %i responses', async status => {
    await withHttp(async http => {
      expect(await http.request('GET', '/requests')).toEqual({ status, cacheControl: 'no-store',
        body: { ok: false, error: { code: 'SYNTHETIC_AUTH_REFUSAL' } } })
      expect(http.hostError).not.toHaveBeenCalled()
      for (const fn of Object.values(http.port)) expect(fn).not.toHaveBeenCalled()
    }, (_req, res) => { res.status(status).json({ ok: false, error: { code: 'SYNTHETIC_AUTH_REFUSAL' } }) })
  })
  it('has a no-dispatch closed fallback inside the dedicated mount prefix', async () => {
    const f = fixture(), setHeader = vi.fn(), json = vi.fn()
    const res = { setHeader, json, status: vi.fn() }
    res.status.mockReturnValue(res)
    const fallback = f.stack.at(-1) as unknown as { handle(req: Request, res: Response): Promise<void> }
    await fallback.handle({} as Request, res as unknown as Response)
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith({ ok: false, error: { code: 'NOT_FOUND' } })
    for (const fn of Object.values(f.port)) expect(fn).not.toHaveBeenCalled()
  })
})
