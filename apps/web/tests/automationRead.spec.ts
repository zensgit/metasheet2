import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { AutomationReadClientError, createAutomationReadClient, checkedAutomationReadScheduleDefinition, checkedAutomationReadDateFieldConfirmation, checkedAutomationReadRetryContext, type AutomationReadClient, type AutomationReadGrantInput,
  type AutomationReadRecordActivationInput, type AutomationReadScheduleActivationInput,
  type AutomationReadScheduleActivationRef, type AutomationReadRetryInput } from '../src/services/integration/automationRead'

const grantId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const otherId = '33333333-3333-4333-8333-333333333333'
const activationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const activationKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ruleRevision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const date = '2026-10-01T00:00:00.000Z'
const token = `${btoa('{"alg":"HS256","typ":"JWT"}').replace(/=/gu, '')}.${btoa('{"sub":"synthetic-owner"}').replace(/=/gu, '')}.synthetic-signature`
const otherToken = `${btoa('{"alg":"HS256","typ":"JWT"}').replace(/=/gu, '')}.${btoa('{"sub":"synthetic-other"}').replace(/=/gu, '')}.synthetic-signature`
const selector = { ruleId: 'rule/中文', actionId: 'action-1', systemId: 'system-1', targetId: 'target-1' }
const budget = { maxRows: 20, maxPages: 2, maxReadCount: 5, timeoutMs: 1000 }
const input: AutomationReadGrantInput = { selector, budget, projects: ['PROJECT-1'], triggers: ['manual'], expiresAt: date, maxExecutions: 2 }
const scheduleInput: AutomationReadScheduleActivationInput = { activationKey, selector, projectNo: 'PROJECT-1', budget, expiresAt: date, maxExecutions: 2, expectedRuleRevision: ruleRevision }
const activationInput: AutomationReadRecordActivationInput = { ...scheduleInput, expectedRuleRevision: ruleRevision, expectedRecordCondition: { mode: 'unconditional' } }
const activationRef = { activationId, grantId }
const scheduleRef: AutomationReadScheduleActivationRef = { ...activationRef }
const activationCases = [
  { name: 'record', input: activationInput, path: '/record-activations', run: (owner: AutomationReadClient, value: AutomationReadRecordActivationInput | AutomationReadScheduleActivationInput) => owner.activateRecord(value as AutomationReadRecordActivationInput) },
  { name: 'schedule', input: scheduleInput, path: '/schedule-activations', run: (owner: AutomationReadClient, value: AutomationReadRecordActivationInput | AutomationReadScheduleActivationInput) => owner.activateSchedule(value) },
]
const grant = { ...input, grantId, purpose: 'standalone', status: 'active', usedExecutions: 0, createdAt: date, updatedAt: date }
const option = { selector, budget, ruleName: 'Synthetic rule', allowedTriggers: ['manual'], recordActivationEligible: false, recordTriggerType: null, recordRuleRevision: null, recordCondition: null, scheduleActivationEligible: false, scheduleRuleRevision: null, scheduleDefinition: null }
const cronDefinition = { triggerType: 'schedule.cron', config: { expression: '*/5 * * * *', timezone: 'Asia/Shanghai' } }
const intervalDefinition = { triggerType: 'schedule.interval', intervalMs: 1500, anchorMs: 1790812800123 }
const dateField = { fieldId: 'due-date', fieldType: 'date' as const, schemaRevision: ruleRevision }
const dateDefinition = { triggerType: 'schedule.date_field', config: { dateFieldId: dateField.fieldId, offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }, dateField }
const scheduleOption = { ...option, allowedTriggers: ['schedule'], scheduleActivationEligible: true, scheduleRuleRevision: ruleRevision, scheduleDefinition: cronDefinition }
const recordOption = { ...option, allowedTriggers: ['record'], recordActivationEligible: true, recordTriggerType: 'record.created', recordRuleRevision: ruleRevision, recordCondition: { mode: 'unconditional' } }
const ref = { requestId, status: 'queued' }
const preview = { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const summary = { ...ref, grantId, projectNo: 'PROJECT-1', trigger: 'manual', createdAt: date, startedAt: null, finishedAt: null }
const retryInput: AutomationReadRetryInput = { retryKey: activationKey, budget, expiresAt: date, acknowledgeNewRead: true }
const retryRef = { parentRequestId: requestId, grantId: activationId, requestId: otherId, status: 'queued' }
const retryContext = { request: { ...summary, status: 'outcome_unknown' }, grant, nextAttempt: null }
const dateRetryContext = {
  request: { ...summary, status: 'outcome_unknown', trigger: 'schedule' },
  grant: { ...grant, purpose: 'automatic', triggers: ['schedule'] }, nextAttempt: null,
  dateScheduleOrigin: { definition: dateDefinition, ruleRevision },
}
const transportCases = [
  { name: 'options GET', run: (owner: AutomationReadClient) => owner.options({ sheetId: 's' }), data: { items: [option], nextCursor: null }, status: 200 },
  { name: 'record activation POST', run: (owner: AutomationReadClient) => owner.activateRecord(activationInput), data: activationRef, status: 201 },
  { name: 'schedule activation POST', run: (owner: AutomationReadClient) => owner.activateSchedule(scheduleInput), data: scheduleRef, status: 201 },
  { name: 'manual submit POST', run: (owner: AutomationReadClient) => owner.submit({ grantId, invocationId: 'timeout-once', projectNo: 'p' }), data: ref, status: 202 },
  { name: 'retry context GET', run: (owner: AutomationReadClient) => owner.retryContext(requestId), data: retryContext, status: 200 },
  { name: 'linked retry POST', run: (owner: AutomationReadClient) => owner.retry(requestId, retryInput), data: retryRef, status: 202 },
]
const clients: AutomationReadClient[] = []
const fetchMock = vi.fn<typeof fetch>()
function client() { const value = createAutomationReadClient(); clients.push(value); return value }
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } }) }
function failure(code: string, status = 403) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'content-type': 'application/json' } }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('auth_token', token)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  for (const value of clients.splice(0)) value.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

describe('Automation A owner transport', () => {
  it('sends a detached four-key linked retry command and never retries a lost response automatically', async () => {
    const owner = client(), mutable = { ...retryInput, budget: { ...budget } }
    fetchMock.mockRejectedValueOnce(new Error('synthetic response loss'))
    const first = owner.retry(requestId, mutable)
    mutable.budget.maxRows = 1
    await expect(first).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]!.body))
    expect(sent).toEqual(retryInput)
    expect(Object.keys(sent).sort()).toEqual(['acknowledgeNewRead', 'budget', 'expiresAt', 'retryKey'])
    fetchMock.mockResolvedValueOnce(reply(retryRef, 202))
    await expect(owner.retry(requestId, retryInput)).resolves.toEqual(retryRef)
    expect(fetchMock.mock.calls[1][1]!.body).toBe(fetchMock.mock.calls[0][1]!.body)
  })
  it.each(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])('observes retry context without claiming fresh execution eligibility: %s', async status => {
    const context = { ...retryContext, request: { ...summary, status, trigger: 'record' }, grant: { ...grant, purpose: 'automatic', triggers: ['record'] } }
    fetchMock.mockResolvedValueOnce(reply(context))
    await expect(client().retryContext(requestId)).resolves.toEqual(context)
  })
  it.each([
    { ...retryInput, acknowledgeNewRead: false }, { ...retryInput, acknowledgeNewRead: 'true' },
    { ...retryInput, retryKey: 'not-uuid' }, { ...retryInput, expiresAt: '2026-10-01' },
    { ...retryInput, budget: { ...budget, maxRows: 0 } }, { ...retryInput, selector },
    { ...retryInput, projectNo: 'PROJECT-1' }, { ...retryInput, trigger: 'manual' },
    { ...retryInput, tenantId: 'self' }, { ...retryInput, maxExecutions: 2 },
  ])('rejects malformed or expanded retry input before IO %#', async invalid => {
    await expect(client().retry(requestId, invalid as AutomationReadRetryInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects retry input accessors, inherited fields, hooks and symbols without invoking them', async () => {
    const getter = vi.fn(() => true), hook = vi.fn(() => retryInput)
    for (const invalid of [Object.create(retryInput), { ...retryInput, toJSON: hook },
      { ...retryInput, [Symbol('hidden')]: 1 }, Object.defineProperty({ ...retryInput }, 'acknowledgeNewRead', { get: getter })]) {
      await expect(client().retry(requestId, invalid)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    }
    expect(getter).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    { ...retryContext, request: { ...retryContext.request, requestId: otherId } },
    { ...retryContext, request: { ...retryContext.request, grantId: otherId } },
    { ...retryContext, request: { ...retryContext.request, projectNo: 'UNRELATED' } },
    { ...retryContext, request: { ...retryContext.request, trigger: 'record' } },
    { ...retryContext, secret: 'must-not-render' },
    { ...retryContext, nextAttempt: { requestId, grantId: activationId } },
    { ...retryContext, nextAttempt: { requestId: otherId, grantId } },
    { ...retryContext, nextAttempt: { requestId: otherId, grantId: activationId, token: 'private' } },
  ])('rejects unrelated or expanded retry context %#', async context => {
    fetchMock.mockResolvedValueOnce(reply(context))
    await expect(client().retryContext(requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })
  it.each([
    { ...retryRef, parentRequestId: activationId }, { ...retryRef, requestId },
    { ...retryRef, grantId: 'invalid' }, { ...retryRef, status: 'unknown' },
    { ...retryRef, selector }, { ...retryRef, fingerprint: 'private' },
  ])('rejects a malformed linked retry receipt %#', async response => {
    fetchMock.mockResolvedValueOnce(reply(response, 202))
    await expect(client().retry(requestId, retryInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })
  it('accepts a bounded retry grant and existing child without allowing automatic or multi-use retry grants', async () => {
    const context = { ...retryContext, grant: { ...grant, purpose: 'retry', maxExecutions: 1 }, nextAttempt: { requestId: otherId, grantId: activationId } }
    fetchMock.mockResolvedValueOnce(reply(context))
    await expect(client().retryContext(requestId)).resolves.toEqual(context)
    for (const invalid of [{ ...context.grant, maxExecutions: 2 }, { ...context.grant, triggers: ['record'] },
      { ...context.grant, projects: ['PROJECT-1', 'PROJECT-2'] }, { ...context.grant, triggers: ['manual', 'record'] }]) {
      fetchMock.mockResolvedValueOnce(reply(invalid))
      await expect(client().grantDetail(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    }
  })
  it.each(['automatic', 'retry'])('observes a %s date origin without treating its metadata as new execution authority', async purpose => {
    const context = { ...dateRetryContext, grant: { ...dateRetryContext.grant, purpose, maxExecutions: 1 } }
    fetchMock.mockResolvedValueOnce(reply(context))
    await expect(client().retryContext(requestId)).resolves.toEqual(context)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    fetchMock.mockResolvedValueOnce(reply(context.grant))
    await expect(client().grantDetail(grantId)).resolves.toEqual(context.grant)
  })
  it('retains a detached frozen date retry origin including exact optional config spelling', () => {
    const definition = { ...dateDefinition, config: { ...dateDefinition.config,
      effectiveAt: '2026-10-01T08:00:00.123456+08:00', scanIntervalMs: 1234 }, dateField: { ...dateField } }
    const original = { ...dateRetryContext, dateScheduleOrigin: { definition, ruleRevision } }
    const checked = checkedAutomationReadRetryContext(original, requestId)
    expect(checked).toEqual(original)
    expect(checked.dateScheduleOrigin).not.toBe(original.dateScheduleOrigin)
    expect(checked.dateScheduleOrigin?.definition).not.toBe(definition)
    for (const value of [checked.dateScheduleOrigin, checked.dateScheduleOrigin?.definition,
      checked.dateScheduleOrigin?.definition.config, checked.dateScheduleOrigin?.definition.dateField]) expect(Object.isFrozen(value)).toBe(true)
    original.dateScheduleOrigin.ruleRevision = activationId
    definition.config.timezone = 'UTC'; definition.dateField.fieldId = 'changed'
    expect(checked.dateScheduleOrigin).toEqual({ ruleRevision, definition: { ...dateDefinition,
      config: { ...dateDefinition.config, effectiveAt: '2026-10-01T08:00:00.123456+08:00', scanIntervalMs: 1234 } } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    { ...dateRetryContext, dateScheduleOrigin: null },
    { ...dateRetryContext, dateScheduleOrigin: {} },
    ...[cronDefinition, intervalDefinition].map(definition => ({ ...dateRetryContext, dateScheduleOrigin: { definition, ruleRevision } })),
    ...['bad', ruleRevision.toUpperCase()].map(revision => ({ ...dateRetryContext, dateScheduleOrigin: { definition: dateDefinition, ruleRevision: revision } })),
    ...['recordId', 'dateValue', 'occurrence', 'authorityKey', 'sourceReference'].map(key => ({ ...dateRetryContext,
      dateScheduleOrigin: { ...dateRetryContext.dateScheduleOrigin, [key]: 'SYN-PRIVATE-NOT-PUBLIC' } })),
    { ...dateRetryContext, dateScheduleOrigin: { definition: { ...dateDefinition, recordId: 'SYN-PRIVATE-NOT-PUBLIC' }, ruleRevision } },
    { ...dateRetryContext, dateScheduleOrigin: { definition: { ...dateDefinition, config: { ...dateDefinition.config, dateValue: 'SYN-PRIVATE-NOT-PUBLIC' } }, ruleRevision } },
    { ...dateRetryContext, dateScheduleOrigin: { definition: { ...dateDefinition, dateField: { ...dateField, value: 'SYN-PRIVATE-NOT-PUBLIC' } }, ruleRevision } },
    { ...dateRetryContext, dateScheduleOrigin: { definition: { ...dateDefinition, dateField: { ...dateField, fieldId: 'other' } }, ruleRevision } },
    { ...dateRetryContext, grant: { ...dateRetryContext.grant, purpose: 'standalone' } },
    { ...retryContext, dateScheduleOrigin: dateRetryContext.dateScheduleOrigin },
    { ...dateRetryContext, request: { ...dateRetryContext.request, trigger: 'record' }, grant: { ...dateRetryContext.grant, triggers: ['record'] } },
    { ...dateRetryContext, grant: { ...dateRetryContext.grant, triggers: ['manual', 'schedule'] } },
    { request: dateRetryContext.request, grant: { ...dateRetryContext.grant, purpose: 'retry', maxExecutions: 1 }, nextAttempt: null },
  ])('rejects malformed, private or mismatched date retry origins at the response boundary %#', async context => {
    fetchMock.mockResolvedValueOnce(reply(context))
    await expect(client().retryContext(requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('date retry observation rejects accessors, hooks and custom prototypes without invoking them', () => {
    const getter = vi.fn(), toJSON = vi.fn(), origin = dateRetryContext.dateScheduleOrigin
    const hostileOrigins = [undefined, Object.create(origin), { ...origin, toJSON }, { ...origin, [Symbol('private')]: true },
      Object.defineProperty({ ...origin }, 'definition', { enumerable: true, get: getter }),
      Object.defineProperty({ ...origin }, 'ruleRevision', { enumerable: true, get: getter }),
      { ...origin, definition: Object.defineProperty({ ...dateDefinition }, 'config', { enumerable: true, get: getter }) },
      { ...origin, definition: { ...dateDefinition, config: { ...dateDefinition.config, toJSON } } },
      { ...origin, definition: { ...dateDefinition, dateField: Object.defineProperty({ ...dateField }, 'schemaRevision', { enumerable: true, get: getter }) } },
    ]
    for (const dateScheduleOrigin of hostileOrigins) expect(() => checkedAutomationReadRetryContext({ ...dateRetryContext, dateScheduleOrigin }, requestId))
      .toThrow(AutomationReadClientError)
    expect(() => checkedAutomationReadRetryContext(Object.defineProperty({ ...dateRetryContext }, 'dateScheduleOrigin', { enumerable: true, get: getter }), requestId))
      .toThrow(AutomationReadClientError)
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  const savedCondition = { mode: 'saved_conditions' as const, schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai' }
  it('sends detached closed condition consent and receives only values-free metadata', async () => {
    const owner = client(), descriptor = { ...savedCondition }
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...recordOption, recordCondition: descriptor }], nextCursor: null }))
    const page = await owner.options({ sheetId: 'synthetic-sheet' })
    expect(page.items[0].recordCondition).toEqual(savedCondition)
    expect(Object.keys(page.items[0].recordCondition!).sort()).toEqual(['businessTimeZone', 'mode', 'schemaRevision'])
    expect(Object.isFrozen(page.items[0].recordCondition)).toBe(true)
    fetchMock.mockResolvedValueOnce(reply(activationRef, 201))
    const sent = owner.activateRecord({ ...activationInput, expectedRecordCondition: descriptor })
    descriptor.schemaRevision = otherId; descriptor.businessTimeZone = 'UTC'
    await sent
    const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
    expect(body.expectedRecordCondition).toEqual(savedCondition)
    expect(Object.keys(body).sort()).toEqual(['activationKey', 'budget', 'expectedRecordCondition', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector'])
  })
  it.each([undefined, null, {}, [], false, { mode: 'unknown' }, { mode: 'unconditional', schemaRevision: ruleRevision },
    { mode: 'saved_conditions' }, { ...savedCondition, schemaRevision: 'invalid' }, { ...savedCondition, schemaRevision: ruleRevision.toUpperCase() },
    { ...savedCondition, businessTimeZone: 'Invalid/Zone' }, { ...savedCondition, businessTimeZone: ' UTC ' },
    { ...savedCondition, conditions: { value: 'private-value' } }, { ...savedCondition, fingerprint: 'a'.repeat(64) },
  ].map(value => ({ value })))('rejects malformed condition preconditions before IO and malformed option response %#', async ({ value }) => {
    await expect(client().activateRecord({ ...activationInput, expectedRecordCondition: value } as AutomationReadRecordActivationInput))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...recordOption, recordCondition: value }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })
  it('rejects old seven-key record activation, condition hooks, and false-eligibility descriptions', async () => {
    const getter = vi.fn(() => 'saved_conditions'), hook = vi.fn(() => savedCondition)
    const invalid = [Object.create(savedCondition), Object.defineProperty({ ...savedCondition }, 'mode', { enumerable: true, get: getter }),
      { ...savedCondition, toJSON: hook }, { ...savedCondition, [Symbol('private')]: true }]
    for (const expectedRecordCondition of invalid) await expect(client().activateRecord({ ...activationInput, expectedRecordCondition }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    const old = { ...activationInput }; Reflect.deleteProperty(old, 'expectedRecordCondition')
    await expect(client().activateRecord(old)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...option, recordCondition: savedCondition }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    await expect(client().activateSchedule({ ...scheduleInput, expectedRecordCondition: savedCondition } as AutomationReadScheduleActivationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('uses all thirteen real route contracts, fixed same-origin transport and no inherited scope', async () => {
    const owner = client()
    const operations = [
      { call: () => owner.options({ sheetId: 'sheet/中文', limit: 1, after: selector.ruleId }), path: '/options?sheetId=sheet%2F%E4%B8%AD%E6%96%87&limit=1&after=rule%2F%E4%B8%AD%E6%96%87', data: { items: [option], nextCursor: selector.ruleId }, method: 'GET', status: 200 },
      { call: () => owner.createGrant(input), path: '/grants', data: { grantId }, method: 'POST', status: 201, body: input },
      { call: () => owner.activateRecord(activationInput), path: '/record-activations', data: activationRef, method: 'POST', status: 201, body: activationInput },
      { call: () => owner.activateSchedule(scheduleInput), path: '/schedule-activations', data: scheduleRef, method: 'POST', status: 201, body: scheduleInput },
      { call: () => owner.listGrants({ limit: 1, after: grantId }), path: `/grants?limit=1&after=${grantId}`, data: { items: [grant], nextCursor: grantId }, method: 'GET', status: 200 },
      { call: () => owner.grantDetail(grantId), path: `/grants/${grantId}`, data: grant, method: 'GET', status: 200 },
      { call: () => owner.revoke(grantId), path: `/grants/${grantId}/revoke`, data: { grantId, status: 'revoked' }, method: 'POST', status: 200 },
      { call: () => owner.submit({ grantId, invocationId: 'bounded/recover-1', projectNo: 'PROJECT-1' }), path: '/requests', data: ref, method: 'POST', status: 202, body: { grantId, invocationId: 'bounded/recover-1', projectNo: 'PROJECT-1' } },
      { call: () => owner.listRequests({ limit: 1, after: requestId, grantId }), path: `/requests?limit=1&after=${requestId}&grantId=${grantId}`, data: { items: [summary], nextCursor: requestId }, method: 'GET', status: 200 },
      { call: () => owner.observe(requestId), path: `/requests/${requestId}`, data: { requestId, status: 'succeeded', result: preview }, method: 'GET', status: 200 },
      { call: () => owner.cancel(requestId), path: `/requests/${requestId}/cancel`, data: { requestId, status: 'cancelled' }, method: 'POST', status: 200 },
      { call: () => owner.retryContext(requestId), path: `/requests/${requestId}/retry-context`, data: retryContext, method: 'GET', status: 200 },
      { call: () => owner.retry(requestId, retryInput), path: `/requests/${requestId}/retry`, data: retryRef, method: 'POST', status: 202, body: retryInput },
    ]
    for (const entry of operations) {
      fetchMock.mockResolvedValueOnce(reply(entry.data, entry.status))
      expect(await entry.call()).toEqual(entry.data)
      const [url, options] = fetchMock.mock.calls.at(-1)!
      expect(url).toBe(`/api/integration/automation-read${entry.path}`)
      expect(options).toEqual({ method: entry.method, credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...('body' in entry ? { 'Content-Type': 'application/json' } : {}) },
        ...('body' in entry ? { body: expect.any(String) } : {}),
      })
      if ('body' in entry) expect(JSON.parse(String(options?.body))).toEqual(entry.body)
    }
    expect(fetchMock).toHaveBeenCalledTimes(13)
  })

  it.each([null, '', ' a.b.c', 'a.b.c ', 'a.b', 'a.b.c.d', 'a.b.\nc', 'a.b.c\t', 'a.b.c=', 'a'.repeat(16385)])('refuses an absent/malformed raw bearer without fetching (%s)', raw => {
    localStorage.clear()
    if (raw !== null) localStorage.setItem('auth_token', raw)
    expect(() => client()).toThrowError(new AutomationReadClientError('UNAUTHORIZED'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['scope', { sheetId: 's', tenantId: 'self-reported' }],
    ['headers', { sheetId: 's', headers: { Authorization: 'other' } }],
    ['url', { sheetId: 's', url: 'https://unexpected.invalid' }],
    ['empty', { sheetId: '' }],
    ['trim', { sheetId: ' s' }],
    ['control', { sheetId: 's\n' }],
    ['length', { sheetId: 's'.repeat(256) }],
    ['limit zero', { sheetId: 's', limit: 0 }],
    ['limit > 50', { sheetId: 's', limit: 51 }],
    ['limit string', { sheetId: 's', limit: '1' }],
    ['limit fractional', { sheetId: 's', limit: 1.1 }],
    ['after blank', { sheetId: 's', after: '' }],
    ['after undefined', { sheetId: 's', after: undefined }],
  ])('refuses invalid options before IO: %s', async (_label, value) => {
    await expect(client().options(value as Parameters<AutomationReadClient['options']>[0])).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID', status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not invoke input accessors, toJSON, inherited keys or symbol properties', async () => {
    const getter = vi.fn(() => 's')
    const toJSON = vi.fn(() => ({ sheetId: 's' }))
    for (const value of [Object.defineProperty({}, 'sheetId', { enumerable: true, get: getter }),
      { sheetId: 's', toJSON }, Object.create({ sheetId: 's' }), { sheetId: 's', [Symbol('scope')]: 'hidden' }]) {
      await expect(client().options(value)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    }
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { ...input, ownerId: 'other' }, { ...input, selector: { ...selector, connectionId: 'extra' } },
    { ...input, budget: { ...budget, maxRows: 0 } }, { ...input, budget: { ...budget, timeoutMs: 2147483648 } },
    { ...input, budget: { ...budget, maxReadCount: 0.5 } }, { ...input, projects: [] },
    { ...input, projects: ['P', 'P'] }, { ...input, projects: Array.from({ length: 257 }, (_, i) => `p${i}`) },
    { ...input, projects: [' P'] }, { ...input, triggers: [] }, { ...input, triggers: ['manual', 'manual'] },
    { ...input, triggers: ['webhook'] }, { ...input, maxExecutions: 0 }, { ...input, maxExecutions: 2147483648 },
    { ...input, expiresAt: '2026-10-01' }, { ...input, expiresAt: 'not-time' },
  ])('refuses a malformed grant without normalizing or extending it', async value => {
    await expect(client().createGrant(value as AutomationReadGrantInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses sparse/custom arrays without calling hooks', async () => {
    const values = [new Array(1), Object.assign(['p'], { hidden: 'scope' }), Object.setPrototypeOf(['p'], null)]
    for (const projects of values) await expect(client().createGrant({ ...input, projects })).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ...Object.keys(scheduleInput).map(key => Object.fromEntries(Object.entries(activationInput).filter(([name]) => name !== key))),
    { ...activationInput, activationKey: activationKey.toUpperCase() }, { ...activationInput, activationKey: ` ${activationKey}` },
    { ...activationInput, activationKey: 'not-uuid' }, { ...activationInput, activationKey: undefined },
    { ...activationInput, grantId }, { ...activationInput, purpose: 'automatic' },
    { ...activationInput, triggers: ['record'] }, { ...activationInput, projects: ['PROJECT-1'] },
    { ...activationInput, recordTriggerType: 'record.updated' }, { ...activationInput, expectedRecordTriggerType: 'record.updated' },
    { ...activationInput, tenantId: 'self-reported' }, { ...activationInput, headers: {} },
    { ...activationInput, scheduledAtMs: 1 }, { ...activationInput, expression: '* * * * *' },
    { ...activationInput, cron: '* * * * *' }, { ...activationInput, timezone: 'UTC' },
    { ...activationInput, selector: { ...selector, sourceReference: 'extra' } },
    { ...activationInput, projectNo: '' }, { ...activationInput, projectNo: ' PROJECT-1' },
    { ...activationInput, projectNo: 'p\n' }, { ...activationInput, projectNo: 'p'.repeat(256) },
    { ...activationInput, budget: { ...budget, maxReadCount: 0 } },
    { ...activationInput, budget: { ...budget, timeoutMs: 2147483648 } },
    { ...activationInput, budget: { ...budget, maxRows: 1.1 } },
    { ...activationInput, expiresAt: '2026-10-01' }, { ...activationInput, expiresAt: 'not-time' },
    { ...activationInput, maxExecutions: 0 }, { ...activationInput, maxExecutions: 2147483648 },
  ])('refuses malformed activation input before any IO', async value => {
    for (const operation of activationCases) {
      const candidate = operation.name === 'record' ? value
        : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'expectedRecordCondition'))
      await expect(operation.run(client(), candidate as AutomationReadRecordActivationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects activation accessors, prototypes and serialization hooks without invoking them', async () => {
    const getter = vi.fn(() => activationKey)
    const toJSON = vi.fn(() => activationInput)
    const values = [
      Object.defineProperty({ ...activationInput }, 'activationKey', { enumerable: true, get: getter }),
      { ...activationInput, selector: Object.defineProperty({ ...selector }, 'ruleId', { enumerable: true, get: getter }) },
      { ...activationInput, budget: Object.defineProperty({ ...budget }, 'maxRows', { enumerable: true, get: getter }) },
      { ...activationInput, selector: Object.create(selector) }, { ...activationInput, budget: Object.create(budget) },
      Object.create(activationInput), Object.setPrototypeOf({ ...activationInput }, { inherited: true }),
      { ...activationInput, toJSON }, { ...activationInput, [Symbol('scope')]: 'extra' },
    ]
    for (const value of values) {
      for (const operation of activationCases) {
        // Preserve own accessors, symbols and prototype while adapting only the
        // known valid record-only precondition out of the schedule test body.
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (operation.name === 'schedule') delete descriptors.expectedRecordCondition
        const candidate = Object.create(Object.getPrototypeOf(value), descriptors)
        await expect(operation.run(client(), candidate)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
      }
    }
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(activationCases)('sends only the detached closed $name activation wire body, with no grant upgrade fields', async operation => {
    const value = { ...operation.input, selector: { ...selector }, budget: { ...budget } }
    fetchMock.mockResolvedValueOnce(reply(activationRef, 201))
    const pending = operation.run(client(), value)
    value.selector.ruleId = 'changed-after-call'
    value.budget.maxReadCount = 99
    value.activationKey = otherId
    expect(await pending).toEqual(activationRef)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/integration/automation-read${operation.path}`)
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(operation.input))
  })

  it.each([Object.fromEntries(Object.entries(activationInput).filter(([key]) => key !== 'expectedRuleRevision')), ...[undefined, null, '', 'not-uuid', ruleRevision.toUpperCase(), ` ${ruleRevision}`, 1, {}]
    .map(expectedRuleRevision => ({ ...activationInput, expectedRuleRevision }))])('rejects missing or invalid record revision before posting', async value => {
    await expect(client().activateRecord(value as AutomationReadRecordActivationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('refuses revision accessors without invoking them and refuses record preconditions on schedule bodies', async () => {
    const getter = vi.fn(() => ruleRevision)
    await expect(client().activateRecord(Object.defineProperty({ ...activationInput }, 'expectedRuleRevision', { enumerable: true, get: getter })))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    await expect(client().activateSchedule(activationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(getter).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { grantId }, { activationId }, { ...activationRef, activationKey },
    { ...activationRef, activationId: activationId.toUpperCase() }, { ...activationRef, grantId: 'not-uuid' },
    { ...activationRef, activationId: ` ${activationId}` }, { ...activationRef, grantId: null },
  ])('refuses malformed activation references without retrying', async data => {
    for (const operation of activationCases) {
      fetchMock.mockResolvedValueOnce(reply(data, 201))
      await expect(operation.run(client(), operation.input)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(activationCases.length)
  })

  it.each([200, 202])('requires activation status 201, not %s', async status => {
    for (const operation of activationCases) {
      fetchMock.mockResolvedValueOnce(reply(activationRef, status))
      await expect(operation.run(client(), operation.input)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(activationCases.length)
  })

  it.each([false, true])('preserves explicit record eligibility %s without inferring it from triggers', async recordActivationEligible => {
    const value = { ...option, allowedTriggers: ['record'], recordActivationEligible,
      recordTriggerType: recordActivationEligible ? 'record.created' : null, recordRuleRevision: recordActivationEligible ? ruleRevision : null,
      recordCondition: recordActivationEligible ? recordOption.recordCondition : null }
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    expect((await client().options({ sheetId: 's' })).items).toEqual([value])
  })

  it.each(['record.created', 'record.updated'])('preserves the explicit eligible record trigger type %s', async recordTriggerType => {
    const value = { ...recordOption, recordTriggerType }
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    expect((await client().options({ sheetId: 's' })).items).toEqual([value])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'missing', value: Object.fromEntries(Object.entries(recordOption).filter(([key]) => key !== 'recordTriggerType')) },
    { label: 'undefined', value: { ...recordOption, recordTriggerType: undefined } },
    ...['record.deleted', 'field.value_changed', 'unknown', '', ' record.updated', 'RECORD.UPDATED', 1, true, {}, []]
      .map(recordTriggerType => ({ label: `unknown or nonstring ${JSON.stringify(recordTriggerType)}`, value: { ...recordOption, recordTriggerType } })),
    { label: 'created with false eligibility', value: { ...recordOption, recordActivationEligible: false, recordRuleRevision: null } },
    { label: 'updated with false eligibility', value: { ...recordOption, recordActivationEligible: false, recordTriggerType: 'record.updated', recordRuleRevision: null } },
    { label: 'null with true eligibility', value: { ...recordOption, recordTriggerType: null } },
    ...['sourceReference', 'sourceSnapshot', 'eventData', 'triggerConfig', 'conditions']
      .map(key => ({ label: `extra source field ${key}`, value: { ...recordOption, [key]: {} } })),
  ])('rejects invalid or expanded record trigger metadata: $label', async ({ value }) => {
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    Object.fromEntries(Object.entries(recordOption).filter(([key]) => key !== 'recordRuleRevision')),
    ...[undefined, null, '', 'not-uuid', ruleRevision.toUpperCase(), ` ${ruleRevision}`, 1, {}, []]
      .map(recordRuleRevision => ({ ...recordOption, recordRuleRevision })),
    { ...option, recordRuleRevision: ruleRevision },
  ])('rejects absent, malformed or eligibility-inconsistent option revisions', async value => {
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a present undefined record trigger type in a decoded DTO', async () => {
    const owner = client()
    fetchMock.mockResolvedValueOnce(reply(null))
    const parse = vi.spyOn(JSON, 'parse').mockReturnValueOnce({ ok: true, data: {
      items: [{ ...option, recordTriggerType: undefined }], nextCursor: null,
    } })
    try { await expect(owner.options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' }) }
    finally { parse.mockRestore() }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null, 'true', 1, {}])('rejects missing or malformed record eligibility (%s)', async value => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...option, recordActivationEligible: value }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it('rejects record eligibility true when the operation cannot run on record triggers', async () => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...recordOption, allowedTriggers: ['manual'] }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it.each([false, true])('preserves explicit schedule eligibility %s without inferring it from triggers', async scheduleActivationEligible => {
    const value = { ...option, allowedTriggers: ['schedule'], scheduleActivationEligible,
      scheduleRuleRevision: scheduleActivationEligible ? ruleRevision : null, scheduleDefinition: scheduleActivationEligible ? cronDefinition : null }
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    expect((await client().options({ sheetId: 's' })).items).toEqual([value])
  })

  it.each([
    cronDefinition, { triggerType: 'schedule.cron', config: { cron: '0 0 29 2 *' } },
    { triggerType: 'schedule.cron', config: { cron: '0 0 31 2 1', timezone: 'UTC' } },
    { triggerType: 'schedule.cron', config: { expression: '0,30 9-17/2 * * 0-7' } },
    intervalDefinition, { ...intervalDefinition, intervalMs: 1000 }, { ...intervalDefinition, intervalMs: 2147483647 },
    dateDefinition, { ...dateDefinition, dateField: { ...dateField, fieldType: 'dateTime' } },
    { ...dateDefinition, config: { dateFieldId: dateField.fieldId, offsetDays: 0, direction: 'after' } },
    { ...dateDefinition, config: { ...dateDefinition.config, offsetDays: 36500, effectiveAt: date, scanIntervalMs: 60000 } },
    ...['2024-02-29T23:59:59.123456+14:00', '0100-01-01T00:00:00Z', '2026-10-02T00:00:00.1-13:59'].map(effectiveAt => ({ ...dateDefinition, config: { ...dateDefinition.config, effectiveAt } })),
    ...[1, 2147483648, Number.MAX_SAFE_INTEGER].map(scanIntervalMs => ({ ...dateDefinition, config: { ...dateDefinition.config, scanIntervalMs } })),
  ])('preserves the exact closed schedule definition as detached frozen data %#', async scheduleDefinition => {
    const value = { ...scheduleOption, scheduleDefinition }
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    const actual = (await client().options({ sheetId: 's' })).items[0]
    expect(actual).toEqual(value)
    expect(actual.scheduleDefinition).not.toBe(scheduleDefinition)
    expect(Object.isFrozen(actual.scheduleDefinition)).toBe(true)
    if (actual.scheduleDefinition?.triggerType === 'schedule.cron' || actual.scheduleDefinition?.triggerType === 'schedule.date_field') expect(Object.isFrozen(actual.scheduleDefinition.config)).toBe(true)
    if (actual.scheduleDefinition?.triggerType === 'schedule.date_field') expect(Object.isFrozen(actual.scheduleDefinition.dateField)).toBe(true)
  })

  it('posts a detached date precondition only, without a client-supplied trigger or config', async () => {
    const mutable = { ...scheduleInput, expectedDateField: { ...dateField } }
    fetchMock.mockResolvedValueOnce(reply(scheduleRef, 201))
    const pending = client().activateSchedule(mutable)
    mutable.expectedDateField.fieldId = 'changed-after-submit'
    await expect(pending).resolves.toEqual(scheduleRef)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ ...scheduleInput, expectedDateField: dateField })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).not.toHaveProperty('scheduleDefinition')
  })

  it.each([
    undefined, null, {}, { ...dateField, fieldId: '' }, { ...dateField, fieldId: ' due-date' },
    { ...dateField, fieldType: 'text' }, { ...dateField, fieldType: 'datetime' },
    { ...dateField, schemaRevision: 'bad' }, { ...dateField, schemaRevision: ruleRevision.toUpperCase() },
    { ...dateField, sourceValue: 'private' },
  ].map(value => ({ value })))('refuses malformed date confirmations before transport and in options %#', async ({ value }) => {
    await expect(client().activateSchedule({ ...scheduleInput, expectedDateField: value } as AutomationReadScheduleActivationInput))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...scheduleOption, scheduleDefinition: { ...dateDefinition, dateField: value } }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it.each([
    { triggerType: 'schedule.date_field', config: dateDefinition.config },
    { ...dateDefinition, dateField: { ...dateField, fieldId: 'other-field' } },
    { ...dateDefinition, anchorMs: 1 },
    ...[{}, { ...dateDefinition.config, offsetDays: -1 }, { ...dateDefinition.config, offsetDays: 36501 },
      { ...dateDefinition.config, offsetDays: 1.5 }, { ...dateDefinition.config, offsetDays: '3' },
      { ...dateDefinition.config, direction: 'sideways' }, { ...dateDefinition.config, timezone: 'Bad/Zone' },
      { ...dateDefinition.config, timezone: '' }, { ...dateDefinition.config, timezone: ' UTC' },
      { ...dateDefinition.config, timeOfDay: '9:00' }, { ...dateDefinition.config, timeOfDay: '24:00' },
      { ...dateDefinition.config, timeOfDay: '09:00 ' }, { ...dateDefinition.config, scanIntervalMs: 0 },
      { ...dateDefinition.config, scanIntervalMs: Number.MAX_SAFE_INTEGER + 1 }, { ...dateDefinition.config, scanIntervalMs: 1.5 },
      ...['2026-10-01', '2026-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '0099-01-01T00:00:00Z',
        '2026-10-01T24:00:00Z', '2026-10-01T00:00:00', '2026-10-01T00:00:00.1234567Z',
        '2026-10-01T00:00:00+14:01', '2026-10-01T00:00:00-00:00', '2026-10-01T00:00:00+08:60',
      ].map(effectiveAt => ({ ...dateDefinition.config, effectiveAt })),
      { ...dateDefinition.config, conditions: [] },
    ].map(config => ({ ...dateDefinition, config })),
    { ...cronDefinition, dateField }, { ...intervalDefinition, dateField },
  ])('rejects missing, mismatched or repaired date definitions and non-date expansion %#', async scheduleDefinition => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...scheduleOption, scheduleDefinition }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it('date data-descriptor parsing never invokes getters or serialization hooks at any nesting level', async () => {
    const getter = vi.fn(() => 'date'), toJSON = vi.fn(() => dateField)
    const hostileFields = [
      Object.defineProperty({ ...dateField }, 'fieldType', { enumerable: true, get: getter }),
      { ...dateField, toJSON }, { ...dateField, [Symbol('private')]: true }, Object.create(dateField),
    ]
    for (const expectedDateField of hostileFields) {
      expect(() => checkedAutomationReadDateFieldConfirmation(expectedDateField)).toThrow(AutomationReadClientError)
      await expect(client().activateSchedule({ ...scheduleInput, expectedDateField })).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
      expect(() => checkedAutomationReadScheduleDefinition({ ...dateDefinition, dateField: expectedDateField })).toThrow(AutomationReadClientError)
    }
    for (const value of [
      Object.defineProperty({ ...dateDefinition }, 'dateField', { enumerable: true, get: getter }),
      { ...dateDefinition, config: Object.defineProperty({ ...dateDefinition.config }, 'timezone', { enumerable: true, get: getter }) },
      { ...dateDefinition, config: { ...dateDefinition.config, toJSON } },
    ]) expect(() => checkedAutomationReadScheduleDefinition(value)).toThrow(AutomationReadClientError)
    await expect(client().activateSchedule(Object.defineProperty({ ...scheduleInput }, 'expectedDateField', { enumerable: true, get: getter })))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    const original = { ...dateDefinition, config: { ...dateDefinition.config }, dateField: { ...dateField } }
    const checked = checkedAutomationReadScheduleDefinition(original)
    original.config.timezone = 'UTC'; original.dateField.fieldId = 'other'
    expect(checked).toEqual(dateDefinition)
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    undefined, null, {}, { triggerType: 'schedule.date_field' }, { triggerType: 'schedule.interval', intervalMs: 1000 },
    ...[999, 2147483648, 1.5, '1000', null].map(intervalMs => ({ ...intervalDefinition, intervalMs })),
    ...[0, -1, 1.1, '1790812800123', Number.MAX_SAFE_INTEGER, null].map(anchorMs => ({ ...intervalDefinition, anchorMs })),
    { ...intervalDefinition, timezone: 'UTC' }, { ...intervalDefinition, config: {} },
    { ...cronDefinition, anchorMs: intervalDefinition.anchorMs },
    ...[{}, { cron: '* * * * *', expression: '* * * * *' }, { cron: '* * * * *', conditions: null },
      { cron: 'junk' }, { cron: '* * * *' }, { cron: '* * * * * *' }, { cron: '60 * * * *' },
      { cron: '0 24 * * *' }, { cron: '0 0 0 * *' }, { cron: '0 0 * 13 *' }, { cron: '0 0 * * 8' },
      { cron: '0 0 30 2 *' }, { cron: '0 0 31 4 *' }, { cron: '*/0 * * * *' }, { cron: '2-1 * * * *' },
      { cron: '* * * * *', timezone: '' }, { cron: '* * * * *', timezone: 'Bad/Zone' },
      { cron: '* * * * *', timezone: ' UTC' }, { cron: ' * * * * *' }, { cron: '*\n* * * *' },
    ].map(config => ({ triggerType: 'schedule.cron', config })),
  ])('refuses malformed schedule definitions rather than inventing a schedule %#', async scheduleDefinition => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...scheduleOption, scheduleDefinition }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...scheduleOption, scheduleRuleRevision: undefined }, { ...scheduleOption, scheduleRuleRevision: null },
    { ...scheduleOption, scheduleRuleRevision: ruleRevision.toUpperCase() }, { ...scheduleOption, scheduleRuleRevision: 'bad' },
    { ...option, scheduleDefinition: intervalDefinition }, { ...option, scheduleRuleRevision: ruleRevision },
    Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'scheduleDefinition')),
    Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'scheduleRuleRevision')),
  ])('refuses mismatched or mixed-version schedule consent metadata %#', async value => {
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it('schedule descriptor parsing never invokes hooks and freezes a detached exact config', () => {
    const getter = vi.fn(() => 1500), serialize = vi.fn()
    for (const value of [
      Object.defineProperty({ ...intervalDefinition }, 'intervalMs', { enumerable: true, get: getter }),
      { ...cronDefinition, config: Object.defineProperty({}, 'cron', { enumerable: true, get: getter }) },
      { ...intervalDefinition, [Symbol('hidden')]: true }, { ...intervalDefinition, toJSON: serialize },
      Object.create(intervalDefinition), { ...cronDefinition, config: Object.create(cronDefinition.config) },
    ]) expect(() => checkedAutomationReadScheduleDefinition(value)).toThrow(AutomationReadClientError)
    const original = { triggerType: 'schedule.cron', config: { expression: '0 8 * * *', timezone: 'UTC' } }
    const checked = checkedAutomationReadScheduleDefinition(original)
    original.config.expression = '0 9 * * *'
    expect(checked).toEqual({ triggerType: 'schedule.cron', config: { expression: '0 8 * * *', timezone: 'UTC' } })
    expect(getter).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled()
  })

  it.each([
    Object.fromEntries(Object.entries(scheduleInput).filter(([key]) => key !== 'expectedRuleRevision')),
    ...[undefined, null, '', 'bad', ruleRevision.toUpperCase()].map(expectedRuleRevision => ({ ...scheduleInput, expectedRuleRevision })),
    { ...scheduleInput, scheduleDefinition: intervalDefinition }, { ...scheduleInput, intervalMs: 1500 },
    { ...scheduleInput, anchorMs: intervalDefinition.anchorMs }, { ...scheduleInput, triggerType: 'schedule.interval' },
  ])('schedule requires the exact revision but never sends client-specified phase/config %#', async value => {
    await expect(client().activateSchedule(value as AutomationReadScheduleActivationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('schedule refuses a revision getter before transport', async () => {
    const getter = vi.fn(() => ruleRevision)
    await expect(client().activateSchedule(Object.defineProperty({ ...scheduleInput }, 'expectedRuleRevision', { enumerable: true, get: getter })))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(getter).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 'true', 1, {}])('rejects missing or malformed schedule eligibility (%s)', async value => {
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...option, scheduleActivationEligible: value }], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it.each([
    { ...option, scheduleActivationEligible: true },
    { ...option, allowedTriggers: ['record'], scheduleActivationEligible: true },
    { ...recordOption, allowedTriggers: ['record', 'schedule'], scheduleActivationEligible: true },
    { ...option, scheduleActivationEligible: false, scheduleConfig: {} },
    Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'scheduleActivationEligible')),
    Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'recordActivationEligible')),
  ])('rejects contradictory, expanded or mixed-version eligibility metadata', async value => {
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    undefined, null, 'unknown', ' automatic', 'AUTOMATIC',
  ])('rejects missing or unknown grant purpose (%s)', async purpose => {
    const owner = client()
    fetchMock.mockResolvedValueOnce(reply({ ...grant, purpose }))
    await expect(owner.grantDetail(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    fetchMock.mockResolvedValueOnce(reply({ items: [{ ...grant, purpose }], nextCursor: null }))
    await expect(owner.listGrants()).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it.each([
    { projects: ['P1', 'P2'], triggers: ['record'] }, { projects: [], triggers: ['record'] },
    { projects: ['P1'], triggers: ['manual'] },
    { projects: ['P1', 'P2'], triggers: ['schedule'] }, { projects: [], triggers: ['schedule'] },
    { projects: ['P1'], triggers: ['schedule', 'manual'] },
    { projects: ['P1'], triggers: ['record', 'manual'] }, { projects: ['P1'], triggers: ['record', 'schedule'] },
    { projects: ['P1'], triggers: [] },
  ])('rejects automatic grants with multiple projects, manual execution or mixed families', async shape => {
    const owner = client(), value = { ...grant, ...shape, purpose: 'automatic' }
    fetchMock.mockResolvedValueOnce(reply(value))
    await expect(owner.grantDetail(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    fetchMock.mockResolvedValueOnce(reply({ items: [value], nextCursor: null }))
    await expect(owner.listGrants()).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it.each([
    ['record', 'active'], ['record', 'revoked'], ['schedule', 'active'], ['schedule', 'revoked'],
  ])('preserves singleton automatic %s %s history and keeps standalone grants unchanged', async (trigger, status) => {
    const owner = client(), automatic = { ...grant, purpose: 'automatic', triggers: [trigger], status }
    fetchMock.mockResolvedValueOnce(reply(automatic))
    expect(await owner.grantDetail(grantId)).toEqual(automatic)
    fetchMock.mockResolvedValueOnce(reply({ items: [automatic], nextCursor: null }))
    expect((await owner.listGrants()).items).toEqual([automatic])
    fetchMock.mockResolvedValueOnce(reply(grant))
    expect(await owner.grantDetail(grantId)).toEqual(grant)
  })

  it('rejects non-data decoder DTOs without invoking getters or accepting custom prototypes', async () => {
    const owner = client(), getter = vi.fn(() => true)
    // Native JSON cannot carry descriptors. Intercept only the decoded envelope
    // to exercise the production closed parser, not an invented wire format.
    const values = [
      { data: { items: [Object.defineProperty({ ...option }, 'recordActivationEligible', { enumerable: true, get: getter })], nextCursor: null },
        run: () => owner.options({ sheetId: 's' }), status: 200 },
      { data: { items: [Object.defineProperty({ ...option }, 'recordTriggerType', { enumerable: true, get: getter })], nextCursor: null },
        run: () => owner.options({ sheetId: 's' }), status: 200 },
      { data: { items: [Object.defineProperty({ ...recordOption }, 'recordRuleRevision', { enumerable: true, get: getter })], nextCursor: null },
        run: () => owner.options({ sheetId: 's' }), status: 200 },
      { data: { items: [Object.defineProperty({ ...option }, 'scheduleActivationEligible', { enumerable: true, get: getter })], nextCursor: null },
        run: () => owner.options({ sheetId: 's' }), status: 200 },
      { data: { items: [Object.setPrototypeOf({ ...option }, { inherited: true })], nextCursor: null },
        run: () => owner.options({ sheetId: 's' }), status: 200 },
      { data: Object.defineProperty({ ...grant }, 'purpose', { enumerable: true, get: getter }),
        run: () => owner.grantDetail(grantId), status: 200 },
      { data: Object.setPrototypeOf({ ...grant }, { inherited: true }), run: () => owner.grantDetail(grantId), status: 200 },
      { data: Object.defineProperty({ ...activationRef }, 'activationId', { enumerable: true, get: getter }),
        run: () => owner.activateRecord(activationInput), status: 201 },
      { data: Object.setPrototypeOf({ ...activationRef }, { inherited: true }), run: () => owner.activateRecord(activationInput), status: 201 },
      { data: Object.defineProperty({ ...scheduleRef }, 'grantId', { enumerable: true, get: getter }),
        run: () => owner.activateSchedule(scheduleInput), status: 201 },
      { data: Object.setPrototypeOf({ ...scheduleRef }, { inherited: true }), run: () => owner.activateSchedule(scheduleInput), status: 201 },
    ]
    for (const value of values) {
      fetchMock.mockResolvedValueOnce(reply(null, value.status))
      const parse = vi.spyOn(JSON, 'parse').mockReturnValueOnce({ ok: true, data: value.data })
      try { await expect(value.run()).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' }) }
      finally { parse.mockRestore() }
    }
    expect(getter).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(values.length)
  })

  it('validates IDs and prevents caller-supplied trigger/scope in submit and paging', async () => {
    const owner = client()
    for (const operation of [() => owner.grantDetail('../grants'), () => owner.revoke(grantId.toUpperCase().replace('1111', 'AAAA')),
      () => owner.observe('../requests'), () => owner.cancel(''),
      () => owner.submit({ grantId, invocationId: ' ', projectNo: 'p' }),
      () => owner.submit({ grantId, invocationId: 'once', projectNo: 'p', trigger: 'schedule' } as Parameters<AutomationReadClient['submit']>[0]),
      () => owner.listRequests({ grantId: 'not-uuid' }), () => owner.listRequests({ after: 'not-uuid' }),
      () => owner.listGrants({ after: grantId, workspaceId: 'self' } as Parameters<AutomationReadClient['listGrants']>[0])]) {
      await expect(operation()).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])('keeps request state %s, never invents a successful preview', async status => {
    fetchMock.mockResolvedValue(reply({ requestId, status, result: null }))
    expect(await client().observe(requestId)).toEqual({ requestId, status, result: null })
  })

  it.each([
    { requestId, status: 'running', result: preview },
    { requestId, status: 'succeeded', result: { ...preview, canApply: true } },
    { requestId, status: 'succeeded', result: { ...preview, applyToken: 'private' } },
    { requestId, status: 'succeeded', result: { ...preview, counts: { ...preview.counts, add: -1 } } },
    { requestId, status: 'succeeded', result: { ...preview, counts: { ...preview.counts, update: Number.MAX_SAFE_INTEGER + 1 } } },
    { requestId, status: 'succeeded', result: { ...preview, counts: { ...preview.counts, extra: 1 } } },
    { requestId, status: 'completed', result: null },
    { requestId: otherId, status: 'succeeded', result: preview },
    { requestId, status: 'succeeded', result: preview, authorityDigest: 'private' },
  ])('rejects unsafe or mismatched preview DTOs', async value => {
    fetchMock.mockResolvedValue(reply(value))
    await expect(client().observe(requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID', status: 502 })
  })

  it.each([
    { items: [option, option], nextCursor: null }, { items: [option], nextCursor: 'wrong' }, { items: [], nextCursor: 'wrong' },
    { items: Array.from({ length: 51 }, (_, index) => ({ ...option, selector: { ...selector, ruleId: `r${index}` } })), nextCursor: null },
    { items: [{ ...option, ruleName: 'n'.repeat(161) }], nextCursor: null },
    { items: [{ ...option, allowedTriggers: ['manual', 'manual'] }], nextCursor: null },
    { items: [{ ...option, secret: 'private' }], nextCursor: null }, { items: [], nextCursor: null, total: 0 },
  ])('rejects duplicate, oversized, expanded or dishonest option pages', async data => {
    fetchMock.mockResolvedValue(reply(data))
    await expect(client().options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
  })

  it('rejects malformed grant/history pages and mutation references', async () => {
    const owner = client()
    const cases = [
      { data: { ...grant, usedExecutions: 3 }, run: () => owner.grantDetail(grantId) },
      { data: { ...grant, grantId: otherId }, run: () => owner.grantDetail(grantId) },
      { data: { ...grant, createdAt: date.slice(0, 10) }, run: () => owner.grantDetail(grantId) },
      { data: { items: [grant, grant], nextCursor: null }, run: () => owner.listGrants() },
      { data: { items: [summary], nextCursor: otherId }, run: () => owner.listRequests() },
      { data: { items: [{ ...summary, startedAt: 'bad' }], nextCursor: null }, run: () => owner.listRequests() },
      { data: { grantId: otherId, status: 'revoked' }, run: () => owner.revoke(grantId) },
      { data: { grantId, status: 'active' }, run: () => owner.revoke(grantId) },
      { data: { ...ref, requestId: otherId }, run: () => owner.cancel(requestId) },
    ]
    for (const entry of cases) {
      fetchMock.mockResolvedValueOnce(reply(entry.data))
      await expect(entry.run()).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    }
  })

  it.each(transportCases)('drops raw server payloads, unknown errors and status/code mismatches: $name', async operation => {
    const owner = client()
    const leak = 'sensitive synthetic payload not for UI'
    const cases = [
      new Response(leak, { status: 500 }),
      new Response(JSON.stringify({ ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE', message: leak } }), { status: 503, headers: { 'content-type': 'application/json' } }),
      failure(leak, 503), failure('AUTOMATION_READ_DENIED', 500),
      new Response(JSON.stringify({ ok: true, data: { items: [], nextCursor: null }, error: leak }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ ok: false, data: { items: [], nextCursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } }),
      reply({ items: [], nextCursor: null }, 201),
    ]
    for (const response of cases) {
      fetchMock.mockResolvedValueOnce(response)
      const error = await operation.run(owner).catch(error => error)
      expect(error).toBeInstanceOf(AutomationReadClientError)
      expect(error.code).toBe('AUTOMATION_READ_RESPONSE_INVALID')
      expect(error.cause).toBeUndefined()
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(leak)
    }
  })

  it.each(transportCases.flatMap(operation => [
    ['UNAUTHORIZED', 401], ['AUTOMATION_READ_DENIED', 403], ['AUTOMATION_ACTOR_AUTHORITY_DENIED', 403],
    ['AUTOMATION_READ_SCOPE_CHANGED', 409], ['AUTOMATION_READ_BUDGET_EXHAUSTED', 409], ['AUTOMATION_READ_IDEMPOTENCY_CONFLICT', 409],
    ['AUTOMATION_READ_FENCE_LOST', 409], ['AUTOMATION_READ_RUNTIME_INACTIVE', 503], ['AUTOMATION_READ_UNAVAILABLE', 503],
  ].map(([code, status]) => ({ ...operation, code: String(code), errorStatus: Number(status) }))))('preserves fixed refusal $code/$errorStatus and never retries: $name', async operation => {
    const { code, errorStatus: status } = operation
    const owner = client()
    fetchMock.mockResolvedValueOnce(failure(code as string, status as number))
    await expect(operation.run(owner)).rejects.toMatchObject({ code: status === 403 ? 'AUTOMATION_READ_DENIED' : code, status })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if (status === 401 || status === 403) {
      await expect(owner.listGrants()).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('never retries either GET or committed-unknown POST and preserves explicit submit identity', async () => {
    const owner = client()
    const submitted = { grantId, invocationId: 'stable-recovery', projectNo: 'PROJECT-1' }
    fetchMock.mockRejectedValue(new Error('synthetic sensitive endpoint'))
    await expect(owner.options({ sheetId: 's' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    await expect(owner.submit(submitted)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    await expect(owner.activateRecord(activationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    fetchMock.mockResolvedValueOnce(reply(ref, 202))
    expect(await owner.submit(submitted)).toEqual(ref)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[3][1]?.body)
    fetchMock.mockResolvedValueOnce(reply(activationRef, 201))
    expect(await owner.activateRecord(activationInput)).toEqual(activationRef)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[2][1]?.body).toBe(fetchMock.mock.calls[4][1]?.body)
    await expect(owner.activateSchedule(scheduleInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledTimes(6)
    fetchMock.mockResolvedValueOnce(reply(scheduleRef, 201))
    expect(await owner.activateSchedule(scheduleInput)).toEqual(scheduleRef)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(fetchMock.mock.calls[5][1]?.body).toBe(fetchMock.mock.calls[6][1]?.body)
    expect(fetchMock.mock.calls.slice(5).map(([url]) => url)).toEqual([
      '/api/integration/automation-read/schedule-activations', '/api/integration/automation-read/schedule-activations',
    ])
  })

  it.each(transportCases)('invalidates and aborts synchronously on raw A→B→A notifications: $name', async operation => {
    const owner = client()
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    const result = operation.run(owner).catch(error => error)
    const signal = fetchMock.mock.calls[0][1]?.signal
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', otherToken)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', token)
    expect(signal?.aborted).toBe(true)
    pending.resolve(reply(operation.data, operation.status))
    expect(await result).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    await expect(operation.run(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(transportCases.flatMap(operation => ['storage', 'focus', 'response'].map(mode => ({ ...operation, mode }))))('rejects stale results with session detection at $mode: $name', async operation => {
    const { mode } = operation
    const owner = client()
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    const result = operation.run(owner).catch(error => error)
    localStorage.setItem('auth_token', otherToken)
    if (mode !== 'response') window.dispatchEvent(new Event(mode))
    pending.resolve(reply(operation.data, operation.status))
    expect(await result).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(transportCases)('rechecks after body parsing, not only after response headers: $name', async operation => {
    const owner = client()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const response = new Response(body, { status: operation.status, headers: { 'content-type': 'application/json' } })
    const read = vi.spyOn(body, 'getReader')
    fetchMock.mockResolvedValue(response)
    const result = operation.run(owner).catch(error => error)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    localStorage.setItem('auth_token', otherToken)
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, data: operation.data })))
    controller.close()
    expect(await result).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
  })

  it('disposes idempotently, aborts all in-flight calls and never fetches afterwards', async () => {
    const owner = client()
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    const a = owner.listGrants().catch(error => error)
    const b = owner.listRequests().catch(error => error)
    const c = owner.activateRecord(activationInput).catch(error => error)
    const d = owner.activateSchedule(scheduleInput).catch(error => error)
    owner.dispose(); owner.dispose()
    expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
    pending.resolve(reply({ items: [], nextCursor: null }))
    expect(await a).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(await b).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(await c).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(await d).toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    await expect(owner.createGrant(input)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    await expect(owner.activateRecord(activationInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    await expect(owner.activateSchedule(scheduleInput)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(transportCases)('bounds response size and rejects non-JSON without logging raw material: $name', async operation => {
    const owner = client()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = reply(operation.data, operation.status)
    response.headers.set('content-length', '1048577')
    const read = vi.spyOn(response.body!, 'getReader')
    fetchMock.mockResolvedValueOnce(response)
    await expect(operation.run(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(read).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }))
    await expect(operation.run(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it.each(transportCases)('counts UTF-8 bytes before buffering and stops an oversized streamed reply: $name', async operation => {
    const owner = client()
    const encoded = new TextEncoder().encode('中'.repeat(350000))
    expect(encoded.byteLength).toBeGreaterThan(1048576)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded); controller.close() } })
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/json' } }))
    await expect(operation.run(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_RESPONSE_INVALID' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(transportCases)('times out one network attempt without retrying or leaking its error: $name', async operation => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('private synthetic endpoint')))
    }))
    const result = operation.run(client()).catch(error => error)
    await vi.advanceTimersByTimeAsync(15000)
    const error = await result
    expect(error).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(String(error)).not.toContain('private')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it.each(transportCases.flatMap(operation => ['auth_token', 'jwt', 'devToken', 'metasheet.explicitSessionOrg.v1', null].map(key => ({ ...operation, key }))))('permanently rejects queued cross-tab ABA for $key even when the current token is A: $name', async operation => {
    const { key } = operation
    const owner = client()
    expect(localStorage.getItem('auth_token')).toBe(token)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: token, newValue: otherToken }))
    await expect(operation.run(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(transportCases.flatMap(operation => [401, 403].map(authStatus => ({ ...operation, authStatus }))))('invalidates before reading an unknown global-auth $authStatus envelope: $name', async operation => {
    const status = operation.authStatus
    const owner = client()
    const response = new Response('private global auth error', { status })
    const read = vi.spyOn(response.body!, 'getReader')
    fetchMock.mockResolvedValueOnce(response)
    await expect(operation.run(owner)).rejects.toMatchObject({ code: status === 401 ? 'UNAUTHORIZED' : 'AUTOMATION_READ_DENIED', status })
    expect(read).not.toHaveBeenCalled()
    await expect(owner.listGrants()).rejects.toMatchObject({ code: 'AUTOMATION_READ_SESSION_CHANGED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
