import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as render, nextTick, reactive, ref, type App } from 'vue'

const mocks = vi.hoisted(() => ({ factory: vi.fn() }))
vi.mock('../src/services/integration/automationRead', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/integration/automationRead')>(),
  createAutomationReadClient: mocks.factory,
}))
vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ locale: ref('en') }) }))

import StockPreparationAutomationReadPanel from '../src/components/integration/stockPreparation/StockPreparationAutomationReadPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { AutomationReadClientError, type AutomationReadGrant, type AutomationReadOption, type AutomationReadRecordTriggerType, type AutomationReadRecordActivationInput, type AutomationReadScheduleActivationInput, type AutomationReadScheduleDefinition, type AutomationReadRequestDetail, type AutomationReadRequestSummary, type AutomationReadRetryInput, type AutomationReadRetryRef } from '../src/services/integration/automationRead'

// UI interaction tests with an explicit service double, NOT endpoint/authority evidence.
// The separate Chromium acceptance uses this actual component and the real owner HTTP path.
const grantId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const activationId = '55555555-5555-4555-8555-555555555555'
const childRequestId = '33333333-3333-4333-8333-333333333333'
const childGrantId = '44444444-4444-4444-8444-444444444444'
const retryReceipt: AutomationReadRetryRef = { parentRequestId: requestId, requestId: childRequestId, grantId: childGrantId, status: 'queued' }
const ruleRevision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const nextRuleRevision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const intervalDefinition = { triggerType: 'schedule.interval' as const, intervalMs: 1500, anchorMs: 1790812800123 }
const dateDefinition = {
  triggerType: 'schedule.date_field' as const,
  config: { dateFieldId: 'due-date', offsetDays: 3, direction: 'before' as const, timeOfDay: '08:30', timezone: 'Asia/Shanghai' },
  dateField: { fieldId: 'due-date', fieldType: 'date' as const, schemaRevision: ruleRevision },
}
const option: AutomationReadOption = {
  selector: { ruleId: 'rule-one', actionId: 'action-one', systemId: 'system-one', targetId: 'target-one' },
  ruleName: 'Synthetic controlled read', allowedTriggers: ['manual', 'schedule'], recordActivationEligible: false, recordTriggerType: null, recordRuleRevision: null, recordCondition: null, scheduleActivationEligible: false,
  scheduleRuleRevision: null, scheduleDefinition: null,
  budget: { maxRows: 10, maxPages: 2, maxReadCount: 12, timeoutMs: 5000 },
}
const preview: AutomationReadRequestDetail = {
  requestId, status: 'succeeded',
  result: { status: 'ready', counts: { add: 2, update: 1, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false },
}
function grant(overrides: Partial<AutomationReadGrant> = {}): AutomationReadGrant {
  return {
    selector: { ...option.selector }, budget: { ...option.budget }, projects: ['PROJECT-SYNTHETIC'], triggers: ['manual'],
    expiresAt: new Date(Date.now() + 900_000).toISOString(), maxExecutions: 1, grantId,
    purpose: 'standalone', status: 'active', usedExecutions: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}
function request(overrides: Partial<AutomationReadRequestSummary> = {}): AutomationReadRequestSummary {
  return { requestId, grantId, status: 'queued', projectNo: 'PROJECT-SYNTHETIC', trigger: 'manual', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, ...overrides }
}
function service() {
  return {
    dispose: vi.fn(), options: vi.fn().mockResolvedValue({ items: [option], nextCursor: null }),
    createGrant: vi.fn().mockResolvedValue({ grantId }), grantDetail: vi.fn().mockResolvedValue(grant()),
    activateRecord: vi.fn<(input: AutomationReadRecordActivationInput) => Promise<{ activationId: string; grantId: string }>>().mockResolvedValue({ activationId, grantId }),
    activateSchedule: vi.fn<(input: AutomationReadScheduleActivationInput) => Promise<{ activationId: string; grantId: string }>>().mockResolvedValue({ activationId, grantId }),
    listGrants: vi.fn().mockResolvedValue({ items: [grant()], nextCursor: null }),
    listRequests: vi.fn().mockResolvedValue({ items: [request()], nextCursor: null }),
    revoke: vi.fn().mockResolvedValue({ grantId, status: 'revoked' }),
    submit: vi.fn().mockResolvedValue({ requestId, status: 'queued' }),
    observe: vi.fn().mockResolvedValue(preview), cancel: vi.fn().mockResolvedValue({ requestId, status: 'outcome_unknown' }),
    retryContext: vi.fn().mockResolvedValue({ request: request({ status: 'outcome_unknown' }), grant: grant(), nextAttempt: null }),
    retry: vi.fn<(parentRequestId: string, input: AutomationReadRetryInput) => Promise<AutomationReadRetryRef>>().mockResolvedValue(retryReceipt),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('StockPreparationAutomationReadPanel explicit owner interactions', () => {
  let app: App | null
  let host: HTMLDivElement
  let api: ReturnType<typeof service>
  let props: { projectNo: string; sheetId: string | null; scopeKey: string }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('auth_token', 'synthetic.owner.session')
    api = service()
    mocks.factory.mockReset().mockImplementation(() => api)
    props = reactive({ projectNo: 'PROJECT-SYNTHETIC', sheetId: 'sheet-synthetic', scopeKey: 'scope-a' })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = null
  })
  afterEach(() => {
    app?.unmount()
    host.remove()
    localStorage.clear()
    vi.restoreAllMocks()
  })
  async function mount() {
    app = createApp({ render: () => render(StockPreparationAutomationReadPanel, props) })
    app.mount(host)
    await flush()
  }
  function query(id: string) { return host.querySelector<HTMLElement>(`[data-testid="automation-read-${id}"]`) }
  function button(id: string) {
    const value = query(id)
    expect(value).toBeInstanceOf(HTMLButtonElement)
    return value as HTMLButtonElement
  }
  async function click(id: string) { button(id).click(); await flush() }
  async function input(id: string, value: string | boolean) {
    const element = query(id) as HTMLInputElement | HTMLSelectElement
    expect(element).toBeTruthy()
    if (typeof value === 'boolean') (element as HTMLInputElement).checked = value
    else element.value = value
    element.dispatchEvent(new Event(element.tagName === 'SELECT' || typeof value === 'boolean' ? 'change' : 'input', { bubbles: true }))
    await flush()
  }
  async function authorize() {
    await click('load')
    await input('option', 'rule-one')
    await input('grant-confirm', true)
    await click('create-grant')
  }
  async function ready() { await authorize(); await click('submit'); await click('refresh-request') }
  function recordOption(recordTriggerType: AutomationReadRecordTriggerType = 'record.created'): AutomationReadOption {
    return { ...option, allowedTriggers: ['record'], recordActivationEligible: true, recordTriggerType, recordRuleRevision: ruleRevision, recordCondition: { mode: 'unconditional' } }
  }
  function configureRecord(overrides: Partial<AutomationReadGrant> = {}, recordTriggerType: AutomationReadRecordTriggerType = 'record.created') {
    api.options.mockResolvedValue({ items: [recordOption(recordTriggerType)], nextCursor: null })
    api.grantDetail.mockImplementation(async () => {
      const actual = api.activateRecord.mock.calls.at(-1)?.[0]
      return grant({ purpose: 'automatic', triggers: ['record'], ...(actual ? {
        selector: { ...actual.selector }, projects: [actual.projectNo], budget: { ...actual.budget },
        expiresAt: actual.expiresAt, maxExecutions: actual.maxExecutions,
      } : {}), ...overrides })
    })
  }
  async function prepareRecord() {
    await click('load'); await input('mode', 'record'); await input('option', 'rule-one')
  }
  async function activate() {
    await prepareRecord(); await input('record-confirm', true); await click('activate-record')
  }
  function scheduleOption(definition: AutomationReadScheduleDefinition = { triggerType: 'schedule.cron', config: { cron: '*/5 * * * *', timezone: 'UTC' } }): AutomationReadOption {
    return { ...option, allowedTriggers: ['schedule'], scheduleActivationEligible: true, scheduleRuleRevision: ruleRevision, scheduleDefinition: definition }
  }
  function scheduleGrant(actual: AutomationReadScheduleActivationInput, overrides: Partial<AutomationReadGrant> = {}) {
    return grant({ purpose: 'automatic', triggers: ['schedule'], selector: { ...actual.selector }, projects: [actual.projectNo],
      budget: { ...actual.budget }, expiresAt: actual.expiresAt, maxExecutions: actual.maxExecutions, ...overrides })
  }
  function configureSchedule(overrides: Partial<AutomationReadGrant> = {}, definition?: AutomationReadScheduleDefinition) {
    api.options.mockResolvedValue({ items: [scheduleOption(definition)], nextCursor: null })
    api.grantDetail.mockImplementation(async () => {
      const actual = api.activateSchedule.mock.calls.at(-1)?.[0]
      if (!actual) throw new Error('SYNTHETIC_SCHEDULE_COMMAND_MISSING')
      return scheduleGrant(actual, overrides)
    })
  }
  async function prepareSchedule() {
    await click('load'); await input('mode', 'schedule'); await input('option', 'rule-one')
  }
  async function activateSchedule() {
    await prepareSchedule(); await input('schedule-confirm', true); await click('activate-schedule')
  }

  async function prepareRetry() {
    api.observe.mockResolvedValue({ requestId, status: 'outcome_unknown', result: null })
    await mount(); await click('history-only'); await click('open-request'); await click('load-retry')
  }
  function configureDateRetry(status: AutomationReadRequestSummary['status'] = 'outcome_unknown', overrides: Partial<AutomationReadGrant> = {}) {
    const context = { request: request({ status, trigger: 'schedule' }),
      grant: grant({ purpose: 'automatic', triggers: ['schedule'], ...overrides }), nextAttempt: null,
      dateScheduleOrigin: { definition: { ...dateDefinition, config: { ...dateDefinition.config }, dateField: { ...dateDefinition.dateField } }, ruleRevision } }
    api.retryContext.mockResolvedValue(context)
    return context
  }
  it('observes original retry scope independently of currentGrant and needs explicit new-read consent', async () => {
    await prepareRetry()
    expect(api.retryContext.mock.calls).toEqual([[requestId]])
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(query('current-grant')).toBeNull()
    expect(query('retry-project')?.textContent).toContain('PROJECT-SYNTHETIC')
    expect(query('retry-selector')?.textContent).toContain('rule-one / action-one / system-one / target-one')
    expect(query('retry-warning')?.textContent).toContain('still be in flight')
    expect(query('retry-warning')?.textContent).toContain('new budget')
    expect((query('retry-ttl') as HTMLInputElement).value).toBe('15')
    expect(button('retry').disabled).toBe(true)
    await click('retry')
    expect(api.retry).not.toHaveBeenCalled()
    const before = Date.now()
    await input('retry-confirm', true); await click('retry')
    expect(api.retry).toHaveBeenCalledTimes(1)
    const [parent, body] = api.retry.mock.calls[0]
    expect(parent).toBe(requestId)
    expect(Object.keys(body).sort()).toEqual(['acknowledgeNewRead', 'budget', 'expiresAt', 'retryKey'])
    expect(body).toMatchObject({ acknowledgeNewRead: true, budget: option.budget, retryKey: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 900_000)
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 900_000)
    expect(Object.isFrozen(body)).toBe(true); expect(Object.isFrozen(body.budget)).toBe(true)
    expect(query('retry-receipt')?.dataset.requestId).toBe(childRequestId)
    expect(query('current-request')?.dataset.requestId).toBe(childRequestId)
    expect(query('retry-context')).toBeNull()
    expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
    expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(api.observe.mock.calls).toEqual([[requestId]])
    await flush(); expect(api.retry).toHaveBeenCalledTimes(1)
  })
  it.each(['blocked', 'failed', 'cancelled', 'outcome_unknown'] as const)('date %s parent needs new consent and sends exactly four fields without restoring the old schedule', async status => {
    const context = configureDateRetry(status, { status: 'revoked', usedExecutions: 1, expiresAt: '2026-01-01T00:00:00.000Z' })
    const original = JSON.stringify(context)
    await prepareRetry()
    expect(api.retryContext.mock.calls).toEqual([[requestId]])
    expect(api.options).not.toHaveBeenCalled(); expect(api.grantDetail).not.toHaveBeenCalled()
    expect(query('retry-project')?.textContent).toContain('PROJECT-SYNTHETIC')
    expect(query('retry-date-config')?.textContent).toContain(JSON.stringify(dateDefinition.config))
    expect(query('retry-date-revision')?.textContent).toContain(ruleRevision)
    for (const text of ['schedule.date_field', 'due-date', '(date)', 'before 3 days', '08:30 Asia/Shanghai', `schema=${ruleRevision}`]) {
      expect(query('retry-date-definition')?.textContent).toContain(text)
    }
    for (const text of ['original fixed project once again', 'Dates are not rescanned or reevaluated', 'original schedule, expiry and quota are not restored',
      'earlier read may have occurred', 'separate valid source authorization', 'Date retry children cannot be retried again']) {
      expect(query('retry-date-warning')?.textContent).toContain(text)
    }
    expect(button('retry').disabled).toBe(true)
    await click('retry'); expect(api.retry).not.toHaveBeenCalled()
    await input('retry-confirm', true); await input('retry-ttl', '20')
    expect((query('retry-confirm') as HTMLInputElement).checked).toBe(false)
    await input('retry-confirm', true); await input('retry-budget-maxRows', '9')
    expect((query('retry-confirm') as HTMLInputElement).checked).toBe(false)
    await input('retry-confirm', true)
    const before = Date.now()
    await click('retry')
    expect(api.retry).toHaveBeenCalledTimes(1)
    const [parent, body] = api.retry.mock.calls[0]
    expect(parent).toBe(requestId)
    expect(Object.keys(body).sort()).toEqual(['acknowledgeNewRead', 'budget', 'expiresAt', 'retryKey'])
    expect(body).toMatchObject({ acknowledgeNewRead: true, budget: { ...option.budget, maxRows: 9 }, retryKey: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 1_200_000)
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 1_200_000)
    expect(Object.isFrozen(body)).toBe(true); expect(Object.isFrozen(body.budget)).toBe(true)
    expect(JSON.stringify(context)).toBe(original)
    expect(query('retry-receipt')?.dataset.requestId).toBe(childRequestId)
    expect(query('retry-context')).toBeNull()
    expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
    expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(api.revoke).not.toHaveBeenCalled(); expect(api.observe.mock.calls).toEqual([[requestId]])
    await flush(); expect(api.retry).toHaveBeenCalledTimes(1)
  })
  it.each(['queued', 'running', 'succeeded'] as const)('date %s origin stays observable without offering a new child budget', async status => {
    configureDateRetry(status)
    await prepareRetry()
    expect(query('retry-date-definition')).not.toBeNull(); expect(query('retry-ineligible')).not.toBeNull()
    expect(query('retry-confirm')).toBeNull(); expect(query('retry')).toBeNull()
    expect(api.retry).not.toHaveBeenCalled()
  })
  it.each(['blocked', 'failed', 'cancelled', 'outcome_unknown'] as const)('date retry child in %s state remains view-only and cannot extend the chain', async status => {
    const context = configureDateRetry(status, { purpose: 'retry' })
    context.request.requestId = childRequestId; context.request.grantId = childGrantId; context.grant.grantId = childGrantId
    api.listRequests.mockResolvedValue({ items: [context.request], nextCursor: null })
    api.observe.mockResolvedValue({ requestId: childRequestId, status, result: null })
    await mount(); await click('history-only'); await click('open-request'); await click('load-retry')
    expect(api.retryContext.mock.calls).toEqual([[childRequestId]])
    expect(query('retry-context')?.dataset.parentRequestId).toBe(childRequestId)
    expect(query('retry-date-definition')).not.toBeNull(); expect(query('retry-ineligible')).not.toBeNull()
    expect(query('retry-confirm')).toBeNull(); expect(query('retry')).toBeNull()
    expect(api.retry).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })
  it('date parent with an existing child only opens that child and never mints a new key', async () => {
    const context = configureDateRetry('failed')
    api.retryContext.mockResolvedValue({ ...context, nextAttempt: { requestId: childRequestId, grantId: childGrantId } })
    const uuid = vi.spyOn(crypto, 'randomUUID')
    await prepareRetry()
    expect(host.textContent).toContain('The date child can only be viewed, not retried again')
    expect(query('retry-confirm')).toBeNull(); expect(query('retry')).toBeNull()
    api.observe.mockResolvedValue({ requestId: childRequestId, status: 'queued', result: null })
    await click('open-next-attempt')
    expect(api.observe.mock.calls).toEqual([[requestId], [childRequestId]])
    expect(query('current-request')?.dataset.requestId).toBe(childRequestId)
    expect(api.retry).not.toHaveBeenCalled(); expect(api.createGrant).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled()
  })
  it.each(['origin-private', 'definition-private', 'config-private', 'field-private', 'missing-revision', 'wrong-family', 'standalone', 'retry-without-origin'] as const)
    ('rejects date retry service-double %s without showing private metadata or granting consent', async variant => {
      const context = configureDateRetry('failed'), privateValue = 'SYN-PRIVATE-NEVER-RENDER'
      if (variant === 'origin-private') Object.assign(context.dateScheduleOrigin, { occurrence: privateValue })
      if (variant === 'definition-private') Object.assign(context.dateScheduleOrigin.definition, { recordId: privateValue })
      if (variant === 'config-private') Object.assign(context.dateScheduleOrigin.definition.config, { dateValue: privateValue })
      if (variant === 'field-private') Object.assign(context.dateScheduleOrigin.definition.dateField, { value: privateValue })
      if (variant === 'missing-revision') Reflect.deleteProperty(context.dateScheduleOrigin, 'ruleRevision')
      if (variant === 'wrong-family') Object.assign(context.dateScheduleOrigin, { definition: intervalDefinition })
      if (variant === 'standalone') context.grant.purpose = 'standalone'
      if (variant === 'retry-without-origin') { context.grant.purpose = 'retry'; Reflect.deleteProperty(context, 'dateScheduleOrigin') }
      await prepareRetry()
      expect(query('error')).not.toBeNull(); expect(query('retry-context')).toBeNull()
      expect(query('retry-confirm')).toBeNull(); expect(query('retry')).toBeNull()
      expect(host.textContent).not.toContain(privateValue); expect(api.retry).not.toHaveBeenCalled()
    })
  it('date retry metadata accessors and serialization hooks are rejected before render', async () => {
    const getter = vi.fn(), toJSON = vi.fn(), context = configureDateRetry('failed')
    Object.defineProperty(context.dateScheduleOrigin, 'definition', { enumerable: true, get: getter })
    api.retryContext.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, dateScheduleOrigin: { definition: dateDefinition, ruleRevision, toJSON } })
    await prepareRetry()
    expect(query('retry-context')).toBeNull(); expect(query('error')).not.toBeNull()
    await click('history-only'); await click('open-request'); await click('load-retry')
    expect(query('retry-context')).toBeNull(); expect(query('error')).not.toBeNull()
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(api.retry).not.toHaveBeenCalled()
  })
  it.each(['blocked', 'failed', 'cancelled', 'outcome_unknown'] as const)('permits explicit bounded retry of a %s retry-purpose parent without resurrecting its spent grant', async status => {
    api.retryContext.mockResolvedValue({ request: request({ status }),
      grant: grant({ purpose: 'retry', status: 'revoked', usedExecutions: 1, expiresAt: '2026-01-01T00:00:00.000Z' }), nextAttempt: null })
    await prepareRetry(); await input('retry-confirm', true); await click('retry')
    expect(api.retry).toHaveBeenCalledTimes(1)
    expect(api.submit).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled()
  })
  it.each(['queued', 'running', 'succeeded'] as const)('can observe %s context but cannot create its child budget', async status => {
    api.retryContext.mockResolvedValue({ request: request({ status }), grant: grant(), nextAttempt: null })
    await prepareRetry()
    expect(query('retry-context')).not.toBeNull(); expect(query('retry-ineligible')).not.toBeNull()
    expect(query('retry')).toBeNull(); expect(api.retry).not.toHaveBeenCalled()
  })
  it.each(['record', 'schedule'] as const)('can observe automatic %s context without upgrading it to manual retry', async trigger => {
    api.retryContext.mockResolvedValue({ request: request({ status: 'failed', trigger }),
      grant: grant({ purpose: 'automatic', triggers: [trigger] }), nextAttempt: null })
    await prepareRetry()
    expect(query('retry-context')).not.toBeNull(); expect(query('retry-ineligible')).not.toBeNull()
    expect(query('retry')).toBeNull(); expect(api.retry).not.toHaveBeenCalled()
  })
  it('opens an already linked child without creating a new key, grant or request', async () => {
    api.retryContext.mockResolvedValue({ request: request({ status: 'failed' }), grant: grant(),
      nextAttempt: { requestId: childRequestId, grantId: childGrantId } })
    const uuid = vi.spyOn(crypto, 'randomUUID')
    await prepareRetry()
    expect(query('retry')).toBeNull()
    api.observe.mockResolvedValue({ requestId: childRequestId, status: 'queued', result: null })
    await click('open-next-attempt')
    expect(api.observe.mock.calls).toEqual([[requestId], [childRequestId]])
    expect(query('current-request')?.dataset.requestId).toBe(childRequestId)
    expect(api.retry).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled()
  })
  it('never enables ordinary manual submit from a retry-purpose historical grant', async () => {
    api.grantDetail.mockResolvedValue(grant({ purpose: 'retry' }))
    await mount(); await click('load'); await click('open-grant')
    expect((query('option') as HTMLSelectElement).value).toBe('')
    expect(query('current-grant-purpose')?.textContent).toContain('no separate manual start')
    await input('option', 'rule-one'); await click('submit')
    expect(button('submit').disabled).toBe(true); expect(api.submit).not.toHaveBeenCalled()
  })
  it.each([
    ['retry-ttl', '0'], ['retry-ttl', '1441'], ['retry-ttl', '1.5'],
    ['retry-budget-maxRows', '2147483648'], ['retry-budget-maxPages', '2147483648'],
    ['retry-budget-maxReadCount', '2147483648'], ['retry-budget-timeoutMs', '2147483648'],
    ['retry-budget-maxRows', '0'], ['retry-budget-maxRows', '1.5'],
  ])('bounds new retry input and clears consent when %s changes to %s', async (field, value) => {
    await prepareRetry(); await input('retry-confirm', true); await input(field, value)
    expect((query('retry-confirm') as HTMLInputElement).checked).toBe(false)
    await input('retry-confirm', true); expect(button('retry').disabled).toBe(true)
    await click('retry'); expect(api.retry).not.toHaveBeenCalled()
  })
  it('refreshing observed parent or context clears already checked retry consent', async () => {
    await prepareRetry(); await input('retry-confirm', true); await click('load-retry')
    expect((query('retry-confirm') as HTMLInputElement).checked).toBe(false)
    await input('retry-confirm', true); await click('refresh-request')
    expect(query('retry-context')).toBeNull(); expect(api.retry).not.toHaveBeenCalled()
  })
  it('permits explicitly increasing a previously undersized request without claiming the old budget is a current approval cap', async () => {
    api.retryContext.mockResolvedValue({ request: request({ status: 'failed' }),
      grant: grant({ budget: { ...option.budget, maxReadCount: 1 } }), nextAttempt: null })
    await prepareRetry(); await input('retry-confirm', true); await input('retry-budget-maxReadCount', '2')
    expect((query('retry-confirm') as HTMLInputElement).checked).toBe(false)
    expect(host.textContent).toContain('not current approved limits')
    await input('retry-confirm', true); await click('retry')
    expect(api.retry.mock.calls[0][1].budget.maxReadCount).toBe(2)
    expect(api.options).not.toHaveBeenCalled()
  })
  it.each(['unrelated-request', 'unrelated-grant', 'unrelated-project', 'extra-private-field', 'malformed-retry-purpose'])('refuses a malformed service-double retry context rather than displaying it: %s', async variant => {
    const context = { request: request({ status: 'failed' }), grant: grant(), nextAttempt: null }
    if (variant === 'unrelated-request') context.request.requestId = childRequestId
    if (variant === 'unrelated-grant') context.request.grantId = childGrantId
    if (variant === 'unrelated-project') { context.request.projectNo = 'OTHER'; context.grant.projects = ['OTHER'] }
    if (variant === 'extra-private-field') Object.assign(context, { secret: 'NEVER-SHOW-THIS' })
    if (variant === 'malformed-retry-purpose') context.grant = grant({ purpose: 'retry', triggers: ['record'] })
    api.retryContext.mockResolvedValue(context)
    await prepareRetry()
    expect(query('error')).not.toBeNull(); expect(query('retry-context')).toBeNull()
    expect(host.textContent).not.toContain('NEVER-SHOW-THIS'); expect(api.retry).not.toHaveBeenCalled()
  })
  it.each(['manual', 'date'] as const)('recovers an uncertain %s retry with its exact frozen parent, key, budget and expiry; no new authorization or refresh', async kind => {
    if (kind === 'date') configureDateRetry()
    const held = deferred<AutomationReadRetryRef>()
    api.retry.mockReturnValueOnce(held.promise)
    const uuid = vi.spyOn(crypto, 'randomUUID')
    await prepareRetry(); await input('retry-confirm', true)
    button('retry').click(); button('retry').click(); await flush()
    expect(api.retry).toHaveBeenCalledTimes(1)
    const original = api.retry.mock.calls[0][1]
    expect((query('retry-ttl') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true)
    await input('retry-ttl', '30'); await input('retry-budget-maxRows', '1')
    expect(original.budget).toEqual(option.budget)
    held.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE')); await flush()
    expect(query('retry-recovery')?.dataset.parentRequestId).toBe(requestId)
    expect(query('retry-recovery-expiry')?.textContent).toContain(original.expiresAt)
    expect(button('load').disabled).toBe(true); expect(button('history-only').disabled).toBe(true)
    await click('load'); await click('history-only')
    expect(api.options).not.toHaveBeenCalled(); expect(api.listRequests).toHaveBeenCalledTimes(1)
    await click('recover-retry')
    expect(api.retry.mock.calls[1]).toEqual([requestId, original])
    expect(api.retry.mock.calls[1][1]).toBe(original)
    expect(uuid).toHaveBeenCalledTimes(1); expect(query('retry-recovery')).toBeNull()
    expect(query('retry-receipt')?.dataset.requestId).toBe(childRequestId)
    expect(api.retryContext).toHaveBeenCalledTimes(1); expect(api.createGrant).not.toHaveBeenCalled()
  })
  it.each(['manual', 'date'] as const)('a %s recovery conflict retains the original command and does not silently re-key', async kind => {
    if (kind === 'date') configureDateRetry()
    api.retry.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
      .mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_SCOPE_CHANGED'))
    await prepareRetry(); await input('retry-confirm', true); await click('retry'); await click('recover-retry')
    expect(query('retry-recovery')).not.toBeNull()
    expect(api.retry.mock.calls[1][1]).toBe(api.retry.mock.calls[0][1])
    expect(button('history-only').disabled).toBe(true)
  })
  it.each(['manual', 'date'].flatMap(kind => ['resolve', 'reject'].map(completion => [kind, completion] as const)))
    ('ignores a late %s retry %s after a principal ABA and does not recover outgoing consent', async (kind, completion) => {
    if (kind === 'date') configureDateRetry()
    const held = deferred<AutomationReadRetryRef>(); api.retry.mockReturnValueOnce(held.promise)
    await prepareRetry(); await input('retry-confirm', true); button('retry').click(); await flush()
    localStorage.setItem('auth_token', 'synthetic.other.session'); notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic.owner.session'); notifyAuthPrincipalChange(); await flush()
    if (completion === 'resolve') held.resolve(retryReceipt)
    else held.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    expect(query('retry-receipt')).toBeNull(); expect(query('retry-recovery')).toBeNull()
    expect(query('retry-context')).toBeNull(); expect(query('current-request')).toBeNull()
    expect(api.retry).toHaveBeenCalledTimes(1)
  })
  it.each(['manual', 'date'].flatMap(kind => ['project', 'scope', 'unmount'].map(change => [kind, change] as const)))
    ('drops pending %s retry consent and late response after %s context changes', async (kind, change) => {
    if (kind === 'date') configureDateRetry()
    const held = deferred<AutomationReadRetryRef>(); api.retry.mockReturnValueOnce(held.promise)
    await prepareRetry(); await input('retry-confirm', true); button('retry').click(); await flush()
    if (change === 'project') props.projectNo = 'OTHER'
    else if (change === 'scope') props.scopeKey = 'scope-b'
    else { app!.unmount(); app = null }
    await flush(); held.resolve(retryReceipt); await flush()
    expect(query('retry-receipt')).toBeNull(); expect(query('retry-recovery')).toBeNull()
    expect(query('current-request')).toBeNull()
  })
  it.each(['manual', 'date'].flatMap(kind => (['UNAUTHORIZED', 'AUTOMATION_READ_DENIED'] as const).map(code => [kind, code] as const)))
    ('clears private %s retry state on %s without a recoverable fresh read', async (kind, code) => {
    if (kind === 'date') configureDateRetry()
    api.retry.mockRejectedValueOnce(new AutomationReadClientError(code))
    await prepareRetry(); await input('retry-confirm', true); await click('retry')
    expect(query('error')).not.toBeNull(); expect(query('retry-recovery')).toBeNull()
    expect(query('retry-context')).toBeNull(); expect(query('current-request')).toBeNull()
  })
  it.each(['principal', 'project', 'scope'] as const)('discards late date origin metadata after the %s changes', async change => {
    const context = configureDateRetry(), held = deferred<typeof context>()
    api.retryContext.mockReturnValueOnce(held.promise)
    await prepareRetry()
    expect(api.retryContext).toHaveBeenCalledTimes(1)
    if (change === 'principal') { localStorage.setItem('auth_token', 'synthetic.other.session'); notifyAuthPrincipalChange() }
    else if (change === 'project') props.projectNo = 'OTHER'
    else props.scopeKey = 'scope-b'
    await flush(); held.resolve(context); await flush()
    expect(query('retry-context')).toBeNull(); expect(query('retry-date-definition')).toBeNull()
    expect(query('current-request')).toBeNull(); expect(api.retry).not.toHaveBeenCalled()
  })

  it('mount does not create a client, read metadata, read a source, or assert client authorization', async () => {
    await mount()
    expect(mocks.factory).not.toHaveBeenCalled()
    expect(button('load').disabled).toBe(false)
    expect(host.textContent).toContain('server checks again')
    expect(host.textContent).toContain('does not itself authorize real customer access')
    expect(query('option')).toBeNull()
  })

  it.each([['no session', false, 'sheet-synthetic'], ['no target', true, null]])('cannot load with %s', async (_label, signedIn, sheetId) => {
    if (!signedIn) localStorage.clear()
    props.sheetId = sheetId
    await mount()
    expect(button('load').disabled).toBe(true)
    await click('load')
    expect(mocks.factory).not.toHaveBeenCalled()
  })

  it('loads only three bounded metadata pages on explicit click; no POST and no automatic polling', async () => {
    await mount(); await click('load'); await flush()
    expect(api.options.mock.calls).toEqual([[{ sheetId: 'sheet-synthetic', limit: 20 }]])
    expect(api.listGrants.mock.calls).toEqual([[{ limit: 20 }]])
    expect(api.listRequests.mock.calls).toEqual([[{ limit: 20 }]])
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.observe).not.toHaveBeenCalled()
  })

  it('after runtime options 503, an independent history click can view, revoke, and cancel without another options request', async () => {
    api.options.mockRejectedValue(new AutomationReadClientError('AUTOMATION_READ_RUNTIME_INACTIVE'))
    api.observe.mockResolvedValue({ requestId, status: 'running', result: null })
    await mount(); await click('load')
    expect(query('error')).not.toBeNull()
    expect(query('grant-row')).toBeNull()
    expect(query('request-row')).toBeNull()
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.listGrants).not.toHaveBeenCalled()
    expect(api.listRequests).not.toHaveBeenCalled()
    await click('history-only')
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.listGrants).toHaveBeenCalledTimes(1)
    expect(api.listRequests).toHaveBeenCalledTimes(1)
    expect(query('option')).toBeNull()
    expect(host.textContent).toContain('History only: eligible rules were not requested')
    expect(query('grant-row')).not.toBeNull()
    expect(query('request-row')).not.toBeNull()
    expect(api.revoke).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
    await click('open-grant')
    expect(button('submit').disabled).toBe(true)
    await click('revoke')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    await click('open-request')
    expect(api.observe.mock.calls).toEqual([[requestId]])
    expect(api.cancel).not.toHaveBeenCalled()
    await click('cancel')
    expect(api.cancel.mock.calls).toEqual([[requestId]])
    expect(query('status')?.textContent).toContain('Outcome unknown')
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('management history and controls do not require a selected target sheet', async () => {
    props.sheetId = null
    api.observe.mockResolvedValue({ requestId, status: 'queued', result: null })
    await mount()
    expect(button('load').disabled).toBe(true)
    expect(button('history-only').disabled).toBe(false)
    await click('history-only')
    expect(api.options).not.toHaveBeenCalled()
    expect(api.listGrants.mock.calls).toEqual([[{ limit: 20 }]])
    expect(api.listRequests.mock.calls).toEqual([[{ limit: 20 }]])
    await click('open-grant'); await click('revoke'); await click('open-request'); await click('cancel')
    expect(api.grantDetail.mock.calls).toEqual([[grantId]])
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    expect(api.observe.mock.calls).toEqual([[requestId]])
    expect(api.cancel.mock.calls).toEqual([[requestId]])
    await click('refresh-history')
    expect(api.listGrants).toHaveBeenCalledTimes(2)
    expect(api.listRequests).toHaveBeenCalledTimes(2)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('does not read owner history without a canonical current project', async () => {
    props.projectNo = ''
    await mount()
    expect(button('history-only').disabled).toBe(true)
    await click('history-only')
    expect(mocks.factory).not.toHaveBeenCalled()
  })

  it('a management response failure still clears all private state without silent partial fallback', async () => {
    await mount(); await click('history-only'); await click('open-request')
    expect(query('result')).not.toBeNull()
    api.listRequests.mockRejectedValue(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await click('refresh-history')
    for (const id of ['grant-row', 'request-row', 'current-request', 'result', 'option']) expect(query(id)).toBeNull()
    expect(query('error')).not.toBeNull()
    expect(api.options).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['load', 'history-only', 'refresh-history'])('%s serializes grant and request metadata reads instead of racing the same NOWAIT grant', async action => {
    await mount()
    if (action === 'refresh-history') await click('load')
    api.listGrants.mockClear(); api.listRequests.mockClear()
    const pending = deferred<{ items: AutomationReadGrant[]; nextCursor: null }>()
    api.listGrants.mockReturnValueOnce(pending.promise)
    await click(action)
    expect(api.listGrants).toHaveBeenCalledTimes(1)
    expect(api.listRequests).not.toHaveBeenCalled()
    pending.resolve({ items: [grant()], nextCursor: null })
    await flush()
    expect(api.listRequests.mock.calls).toEqual([[{ limit: 20 }]])
    expect(query('grant-row')).not.toBeNull()
    expect(query('request-row')).not.toBeNull()
  })

  it.each(['load', 'history-only', 'refresh-history'])('%s stops the metadata chain when the session changes during the grant read', async action => {
    await mount()
    if (action === 'refresh-history') await click('load')
    api.listGrants.mockClear(); api.listRequests.mockClear()
    const pending = deferred<{ items: AutomationReadGrant[]; nextCursor: null }>()
    api.listGrants.mockReturnValueOnce(pending.promise)
    await click(action)
    expect(api.listRequests).not.toHaveBeenCalled()
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic.other.session')
    pending.resolve({ items: [grant()], nextCursor: null })
    await flush()
    expect(api.listRequests).not.toHaveBeenCalled()
    expect(query('grant-row')).toBeNull()
    expect(query('request-row')).toBeNull()
    expect(query('error')).toBeNull()
  })

  it('requires selected server option and confirmation; authorization and source submission stay separate', async () => {
    await mount(); await click('load')
    expect(query('create-grant')).toBeNull()
    await input('option', 'rule-one')
    expect(button('create-grant').disabled).toBe(true)
    await click('create-grant')
    expect(api.createGrant).not.toHaveBeenCalled()
    await input('grant-confirm', true)
    const before = Date.now()
    await click('create-grant')
    expect(api.createGrant).toHaveBeenCalledTimes(1)
    const actual = api.createGrant.mock.calls[0][0]
    expect(actual).toEqual({ selector: option.selector, projects: ['PROJECT-SYNTHETIC'], triggers: ['manual'], budget: option.budget, maxExecutions: 1, expiresAt: expect.any(String) })
    expect(Date.parse(actual.expiresAt)).toBeGreaterThanOrEqual(before + 900_000)
    expect(Date.parse(actual.expiresAt)).toBeLessThanOrEqual(Date.now() + 900_000)
    expect(api.grantDetail.mock.calls).toEqual([[grantId]])
    expect(api.submit).not.toHaveBeenCalled()
    expect(button('submit').disabled).toBe(false)
    expect(host.textContent).toContain('no source read started')
  })

  it.each([
    ['ttl', '0'], ['ttl', '1441'], ['executions', '101'], ['executions', '1.5'],
    ['budget-maxRows', '11'], ['budget-maxPages', '3'], ['budget-maxReadCount', '13'], ['budget-timeoutMs', '5001'],
    ['budget-maxRows', '-1'], ['budget-maxRows', '1e2'],
  ])('does not authorize invalid or over-cap %s = %s', async (field, value) => {
    await mount(); await click('load'); await input('option', 'rule-one')
    await input(field, value); await input('grant-confirm', true); await click('create-grant')
    expect(button('create-grant').disabled).toBe(true)
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it('clears confirmation on a changed limit and cannot select a rule without manual permission', async () => {
    api.options.mockResolvedValue({ items: [option, { ...option, selector: { ...option.selector, ruleId: 'schedule-only' }, allowedTriggers: ['schedule'] }], nextCursor: null })
    await mount(); await click('load'); await input('option', 'rule-one'); await input('grant-confirm', true)
    expect(button('create-grant').disabled).toBe(false)
    await input('budget-maxRows', '9')
    expect((query('grant-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('create-grant').disabled).toBe(true)
    await input('option', 'schedule-only'); await input('grant-confirm', true)
    expect(button('create-grant').disabled).toBe(true)
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it('renders queued then actual observed readonly counts; status refresh never resubmits', async () => {
    await mount(); await authorize(); await click('submit')
    expect(api.submit).toHaveBeenCalledTimes(1)
    expect(api.submit.mock.calls[0][0]).toEqual({ grantId, projectNo: 'PROJECT-SYNTHETIC', invocationId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(query('status')?.textContent).toContain('Queued')
    expect(query('result')).toBeNull()
    expect(button('submit').disabled).toBe(true)
    await click('refresh-request'); await flush()
    expect(api.observe.mock.calls).toEqual([[requestId]])
    expect(query('result')?.textContent).toContain('2 / 1 / 0 / 0 / 0')
    expect(query('result')?.textContent).toContain('canApply: false')
    expect(api.submit).toHaveBeenCalledTimes(1)
    expect([...host.querySelectorAll('button')].some(item => /apply|send/i.test(item.textContent ?? ''))).toBe(false)
  })

  it.each(['AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_RESPONSE_INVALID'] as const)('retains exactly the same invocation after %s and never silently starts a replacement', async code => {
    api.submit.mockRejectedValueOnce(new AutomationReadClientError(code))
    await mount(); await authorize(); await click('submit'); await flush()
    expect(api.submit).toHaveBeenCalledTimes(1)
    const original = { ...api.submit.mock.calls[0][0] }
    expect(button('load').disabled).toBe(true)
    expect(button('history-only').disabled).toBe(true)
    expect(query('current-grant')).toBeNull()
    expect(query('result')).toBeNull()
    expect(query('recovery')?.textContent).toContain('same request key')
    await click('recover')
    expect(api.submit).toHaveBeenCalledTimes(2)
    expect(api.submit.mock.calls[1][0]).toEqual(original)
    expect(query('recovery')).toBeNull()
    expect(query('status')?.textContent).toContain('Queued')
  })

  it('never retries a grant-create POST after response loss; the user must inspect history', async () => {
    api.createGrant.mockRejectedValue(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await authorize(); await flush()
    expect(api.createGrant).toHaveBeenCalledTimes(1)
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(query('current-grant')).toBeNull()
    expect(query('recovery')).toBeNull()
    expect(query('error')?.textContent).toContain('check run history')
    expect(button('load').disabled).toBe(false)
  })

  it('clears rendered results and private lists on a current-owner detail 403', async () => {
    await mount(); await ready()
    expect(query('result')).not.toBeNull()
    api.observe.mockRejectedValue(new AutomationReadClientError('AUTOMATION_READ_DENIED'))
    await click('refresh-request')
    for (const id of ['result', 'option', 'current-grant', 'current-request', 'grant-row', 'request-row']) expect(query(id)).toBeNull()
    expect(query('error')?.textContent).toContain('Access refused')
    expect(api.dispose).toHaveBeenCalled()
    expect(api.submit).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'] as const)('discards an old response after A→B→A notification, including %s', async outcome => {
    const pending = deferred<{ items: AutomationReadOption[]; nextCursor: null }>()
    api.options.mockReturnValueOnce(pending.promise)
    await mount(); await click('load')
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic.other.session')
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic.owner.session')
    if (outcome === 'resolve') pending.resolve({ items: [option], nextCursor: null })
    else pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    expect(query('option')).toBeNull()
    expect(query('error')).toBeNull()
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.dispose).toHaveBeenCalled()
    await click('load')
    expect(query('option')).not.toBeNull()
  })

  it.each(['storage', 'focus'] as const)('clears a rendered preview on an external session change signalled by %s', async signal => {
    await mount(); await ready()
    localStorage.setItem('auth_token', 'synthetic.other.session')
    window.dispatchEvent(new Event(signal))
    await flush()
    expect(query('result')).toBeNull()
    expect(query('option')).toBeNull()
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.observe).toHaveBeenCalledTimes(1)
  })

  it('does not lose an unconfirmed submission because an unrelated preference storage event arrives', async () => {
    api.submit.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await authorize(); await click('submit')
    window.dispatchEvent(new StorageEvent('storage', { key: 'metasheet_locale', newValue: 'zh-CN' }))
    await flush()
    expect(query('recovery')).not.toBeNull()
    await click('recover')
    expect(api.submit.mock.calls[1][0]).toEqual(api.submit.mock.calls[0][0])
  })

  it('does not send an outgoing-session command if storage changes immediately before its click', async () => {
    await mount(); await authorize()
    localStorage.setItem('auth_token', 'synthetic.other.session')
    await click('submit')
    expect(api.submit).not.toHaveBeenCalled()
    expect(query('current-grant')).toBeNull()
    expect(query('error')).toBeNull()
  })

  it.each(['projectNo', 'sheetId', 'scopeKey'] as const)('invalidates an in-flight response after %s changes', async key => {
    const pending = deferred<AutomationReadRequestDetail>()
    api.observe.mockReturnValueOnce(pending.promise)
    await mount(); await authorize(); await click('submit'); await click('refresh-request')
    props[key] = 'changed-synthetic'
    await flush()
    pending.resolve(preview)
    await flush()
    expect(query('result')).toBeNull()
    expect(query('current-request')).toBeNull()
    expect(query('option')).toBeNull()
    expect(api.dispose).toHaveBeenCalled()
  })

  it('cancel renders outcome_unknown honestly and does not claim in-flight source IO stopped', async () => {
    api.submit.mockResolvedValue({ requestId, status: 'running' })
    await mount(); await authorize(); await click('submit'); await click('cancel')
    expect(api.cancel.mock.calls).toEqual([[requestId]])
    expect(query('status')?.textContent).toContain('Outcome unknown')
    expect(query('notice')?.textContent).toContain('cannot confirm an in-flight read stopped')
    expect(query('result')).toBeNull()
    expect(api.submit).toHaveBeenCalledTimes(1)
  })

  it('revoke is a distinct explicit POST and removes the start action allowance', async () => {
    await mount(); await authorize(); await click('revoke')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    expect(button('submit').disabled).toBe(true)
    expect(button('revoke').disabled).toBe(true)
    expect(api.submit).not.toHaveBeenCalled()
    expect(query('notice')?.textContent).toContain('does not prove an in-flight read immediately stopped')
  })

  it.each(['ruleId', 'actionId', 'systemId', 'targetId'] as const)('a same-project history grant with a different %s can be viewed but cannot start here', async key => {
    api.grantDetail.mockResolvedValue(grant({ selector: { ...option.selector, [key]: 'another-synthetic-selector' } }))
    await mount(); await click('load'); await click('open-grant')
    expect(query('current-grant')).not.toBeNull()
    expect(button('submit').disabled).toBe(true)
    expect(button('revoke').disabled).toBe(false)
    await click('submit')
    expect(api.submit).not.toHaveBeenCalled()
    expect(host.textContent).toContain('History alone is not permission to start')
  })

  it('can explicitly reopen a matching current-page grant from owner history', async () => {
    await mount(); await click('load'); await click('open-grant')
    expect(button('submit').disabled).toBe(false)
    await click('submit')
    expect(api.submit).toHaveBeenCalledTimes(1)
  })

  it('switching the selected rule does not start the previously created grant under a different label', async () => {
    api.options.mockResolvedValue({ items: [option, { ...option, selector: { ...option.selector, ruleId: 'rule-two', actionId: 'action-two' }, ruleName: 'Another synthetic rule' }], nextCursor: null })
    await mount(); await authorize()
    expect(query('current-grant-rule')?.textContent).toContain(option.ruleName)
    await input('option', 'rule-two')
    expect(button('submit').disabled).toBe(true)
    expect(query('current-grant-rule')?.textContent).toContain(option.ruleName)
    expect(query('current-grant-rule')?.textContent).not.toContain('Another synthetic rule')
    await click('submit')
    expect(api.submit).not.toHaveBeenCalled()
    await input('option', 'rule-one')
    expect(button('submit').disabled).toBe(false)
  })

  it('pages metadata with limit 20, replaces the page, and only displays the current project', async () => {
    const nextGrant = '33333333-3333-4333-8333-333333333333'
    const nextRequest = '44444444-4444-4444-8444-444444444444'
    api.options.mockResolvedValueOnce({ items: [option], nextCursor: 'rule-one' })
    api.listGrants.mockResolvedValueOnce({ items: [grant({ projects: ['OTHER-PROJECT'] })], nextCursor: nextGrant })
    api.listRequests.mockResolvedValueOnce({ items: [request({ projectNo: 'OTHER-PROJECT' })], nextCursor: nextRequest })
    await mount(); await click('load')
    expect(query('grant-row')).toBeNull(); expect(query('request-row')).toBeNull()
    await click('next-options'); await click('next-grants'); await click('next-requests')
    expect(api.options).toHaveBeenLastCalledWith({ sheetId: 'sheet-synthetic', limit: 20, after: 'rule-one' })
    expect(api.listGrants).toHaveBeenLastCalledWith({ limit: 20, after: nextGrant })
    expect(api.listRequests).toHaveBeenLastCalledWith({ limit: 20, after: nextRequest })
    expect(host.querySelectorAll('[data-testid="automation-read-grant-row"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="automation-read-request-row"]')).toHaveLength(1)
    await click('open-request')
    expect(api.observe.mock.calls).toEqual([[requestId]])
    expect(query('result')).not.toBeNull()
    await click('refresh-history')
    expect(api.listRequests).toHaveBeenLastCalledWith({ limit: 20 })
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['record.created', 'record.updated'] as const)('keeps manual as the default; opening %s options does not activate anything', async trigger => {
    configureRecord({}, trigger)
    await mount(); await click('load')
    expect((query('mode') as HTMLSelectElement).value).toBe('manual')
    expect(host.querySelector<HTMLOptionElement>('option[value="rule-one"]')?.disabled).toBe(true)
    expect(query('record-confirm')).toBeNull()
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.observe).not.toHaveBeenCalled()
    await input('mode', 'record')
    expect(host.querySelector<HTMLOptionElement>('option[value="rule-one"]')?.disabled).toBe(false)
    expect((query('option') as HTMLSelectElement).value).toBe('')
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each(['record.created', 'record.updated'] as const)('explicit %s consent sends one closed fixed-project body without manual authorization or source submission', async trigger => {
    configureRecord({}, trigger)
    await mount(); await prepareRecord()
    expect(button('activate-record').disabled).toBe(true)
    expect(query('create-grant')).toBeNull()
    expect((query('ttl') as HTMLInputElement).value).toBe('15')
    expect((query('executions') as HTMLInputElement).value).toBe('1')
    expect(query('record-scope')?.textContent).toContain('not derived from the event row')
    expect(query('record-condition')?.textContent).toContain('Condition mode: unconditional')
    expect(query('record-scope')?.textContent).toContain('including zero-field or unchanged-value updates')
    expect(query('record-scope')?.textContent).toContain('not only actual field-value changes')
    expect(query('record-trigger')?.getAttribute('data-record-trigger-type')).toBe(trigger)
    expect(query('record-trigger')?.textContent).toContain(trigger)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    await input('record-confirm', true)
    const before = Date.now()
    await click('activate-record')
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    const actual = api.activateRecord.mock.calls[0][0]
    expect(actual).toEqual({ activationKey: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      selector: option.selector, projectNo: 'PROJECT-SYNTHETIC', budget: option.budget,
      maxExecutions: 1, expiresAt: expect.any(String), expectedRuleRevision: ruleRevision, expectedRecordCondition: { mode: 'unconditional' } })
    expect(Date.parse(actual.expiresAt)).toBeGreaterThanOrEqual(before + 900_000)
    expect(Date.parse(actual.expiresAt)).toBeLessThanOrEqual(Date.now() + 900_000)
    expect(Object.isFrozen(actual)).toBe(true)
    expect(Object.isFrozen(actual.selector)).toBe(true)
    expect(Object.isFrozen(actual.budget)).toBe(true)
    expect(api.grantDetail.mock.calls).toEqual([[grantId]])
    expect(query('activation-receipt')?.getAttribute('data-activation-id')).toBe(activationId)
    expect(query('activation-receipt')?.getAttribute('data-grant-id')).toBe(grantId)
    expect(query('activation-receipt')?.textContent).toContain('does not prove the authorization is currently effective')
    expect(query('receipt-record-trigger')?.textContent).toContain(trigger)
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic record authorization')
    expect(button('submit').disabled).toBe(true)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.observe).not.toHaveBeenCalled()
  })

  it.each([
    ['ttl', '1441'], ['ttl', '0'], ['executions', '101'], ['executions', '1.5'],
    ['budget-maxRows', '11'], ['budget-maxPages', '3'], ['budget-maxReadCount', '13'], ['budget-timeoutMs', '5001'],
  ])('record activation rejects invalid or over-cap %s = %s', async (field, value) => {
    configureRecord()
    await mount(); await prepareRecord(); await input(field, value); await input('record-confirm', true)
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each(['ttl', 'executions', 'budget-maxRows', 'budget-maxPages', 'budget-maxReadCount', 'budget-timeoutMs'])('changing %s clears the record confirmation', async field => {
    configureRecord()
    await mount(); await prepareRecord(); await input('record-confirm', true)
    expect(button('activate-record').disabled).toBe(false)
    await input(field, field === 'ttl' ? '14' : field === 'budget-maxPages' ? '1' : '2')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
  })

  it('changing rule or authorization mode clears consent and never carries manual consent into record mode', async () => {
    configureRecord()
    api.options.mockResolvedValue({ items: [{ ...recordOption(), allowedTriggers: ['manual', 'record'] },
      { ...recordOption(), selector: { ...option.selector, ruleId: 'second-rule' } }], nextCursor: null })
    await mount(); await click('load'); await input('option', 'rule-one'); await input('grant-confirm', true)
    await input('mode', 'record'); await input('option', 'rule-one')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    await input('record-confirm', true); await input('option', 'second-rule')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    await input('record-confirm', true); await input('mode', 'manual'); await input('mode', 'record'); await input('option', 'rule-one')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it.each([
    ['false eligibility', { recordActivationEligible: false }],
    ['missing eligibility', { recordActivationEligible: undefined }],
    ['truthy nonboolean eligibility', { recordActivationEligible: 'true' }],
    ['record trigger absent', { allowedTriggers: ['manual'] }],
    ['missing record type', { recordTriggerType: undefined }],
    ['null record type', { recordTriggerType: null }],
    ['unsupported record type', { recordTriggerType: 'record.deleted' }],
    ['unknown record type', { recordTriggerType: 'synthetic.private.value' }],
    ['nonstring record type', { recordTriggerType: true }],
    ['missing rule revision', { recordRuleRevision: undefined }],
    ['null rule revision', { recordRuleRevision: null }],
    ['invalid rule revision', { recordRuleRevision: 'not-uuid' }],
    ['noncanonical rule revision', { recordRuleRevision: ruleRevision.toUpperCase() }],
  ])('record handler rejects %s even if a service double offers a malformed selectable option', async (_label, overrides) => {
    configureRecord()
    api.options.mockResolvedValue({ items: [{ ...recordOption(), ...overrides }], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    expect(host.querySelector<HTMLOptionElement>('option[value="rule-one"]')?.disabled).toBe(true)
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(query('record-trigger')?.textContent).not.toContain('synthetic.private.value')
  })

  it('switching created to updated requires new confirmation and shows the server-provided type', async () => {
    configureRecord()
    api.options.mockResolvedValue({ items: [recordOption(), {
      ...recordOption('record.updated'), selector: { ...option.selector, ruleId: 'updated-rule' },
    }], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    expect(button('activate-record').disabled).toBe(false)
    await input('option', 'updated-rule')
    expect(query('record-trigger')?.getAttribute('data-record-trigger-type')).toBe('record.updated')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    await input('record-confirm', true); await click('activate-record')
    expect(api.activateRecord.mock.calls[0][0].selector.ruleId).toBe('updated-rule')
    expect(Object.keys(api.activateRecord.mock.calls[0][0]).sort()).toEqual([
      'activationKey', 'budget', 'expectedRecordCondition', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector',
    ])
  })

  it.each(['record.created', 'record.updated'] as const)('requires explicit %s saved-condition consent without exposing constants', async trigger => {
    configureRecord({}, trigger)
    const descriptor = { mode: 'saved_conditions' as const, schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai' }
    api.options.mockResolvedValue({ items: [{ ...recordOption(trigger), recordCondition: descriptor }], nextCursor: null })
    await mount(); await prepareRecord()
    expect(query('record-condition')?.getAttribute('data-record-condition-mode')).toBe('saved_conditions')
    expect(query('record-condition')?.textContent).toContain('Asia/Shanghai')
    expect(query('record-scope')?.textContent).toContain('event-time private after-image')
    expect(query('record-scope')?.textContent).toContain('The current row is never re-read')
    await click('activate-record'); expect(api.activateRecord).not.toHaveBeenCalled()
    await input('record-confirm', true); await click('activate-record')
    const actual = api.activateRecord.mock.calls[0][0]
    expect(actual.expectedRecordCondition).toEqual(descriptor)
    expect(actual.expectedRecordCondition).not.toBe(descriptor)
    expect(Object.isFrozen(actual.expectedRecordCondition)).toBe(true)
    expect(query('receipt-record-condition')?.textContent).toContain('saved conditions')
    expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })
  it.each(['schemaRevision', 'businessTimeZone'] as const)('changing nested condition %s clears consent even if it returns to the prior value', async field => {
    configureRecord()
    const supplied = reactive({ ...recordOption(), recordCondition: {
      mode: 'saved_conditions' as const, schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai',
    } })
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    const previous = supplied.recordCondition[field]
    supplied.recordCondition[field] = field === 'schemaRevision' ? nextRuleRevision : 'UTC'
    supplied.recordCondition[field] = previous
    await flush()
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record'); expect(api.activateRecord).not.toHaveBeenCalled()
  })
  it('changing the condition mode clears consent without changing event type or rule id', async () => {
    configureRecord()
    const supplied = reactive(recordOption())
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    supplied.recordCondition = { mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'UTC' }
    await flush()
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
    await input('record-confirm', true); await click('activate-record')
    expect(api.activateRecord.mock.calls[0][0].expectedRecordCondition).toEqual(supplied.recordCondition)
  })
  it.each([undefined, null, {}, { mode: 'private-value' }, { mode: 'unconditional', ast: 'private-literal' },
    { mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Invalid/Zone' },
  ].map(value => ({ value })))('cannot activate a malformed synthetic option condition %#', async ({ value }) => {
    configureRecord()
    api.options.mockResolvedValue({ items: [{ ...recordOption(), recordCondition: value }], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(host.textContent).not.toMatch(/private-value|private-literal/)
  })
  it('does not invoke nested condition accessors while deciding a synthetic option or rendering consent', async () => {
    configureRecord(); const getter = vi.fn(() => 'saved_conditions')
    api.options.mockResolvedValue({ items: [{ ...recordOption(), recordCondition: Object.defineProperty({}, 'mode', { enumerable: true, get: getter }) }], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true); await click('activate-record')
    expect(getter).not.toHaveBeenCalled(); expect(api.activateRecord).not.toHaveBeenCalled()
  })
  it.each(['receipt-lost', 'detail-failed'] as const)('freezes condition descriptor and original key across %s, without refreshing options or budget', async failure => {
    configureRecord({}, 'record.updated')
    const supplied = reactive({ ...recordOption('record.updated'), recordCondition: {
      mode: 'saved_conditions' as const, schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai',
    } })
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    if (failure === 'detail-failed') api.grantDetail.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    supplied.recordCondition.schemaRevision = nextRuleRevision; supplied.recordCondition.businessTimeZone = 'UTC'
    if (failure === 'receipt-lost') pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    else pending.resolve({ activationId, grantId })
    await flush()
    expect(query('recovery-record-condition')?.textContent).toContain('Asia/Shanghai')
    expect(button('load').disabled).toBe(true)
    await click('recover-activation')
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(original.expectedRecordCondition).toEqual({ mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai' })
    expect(query('receipt-record-condition')?.textContent).toContain('Asia/Shanghai')
    expect(api.activateSchedule).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('discards frozen saved-condition display and late %s after session ABA', async outcome => {
    configureRecord()
    api.options.mockResolvedValue({ items: [{ ...recordOption(), recordCondition: {
      mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai',
    } }], nextCursor: null })
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.other.session')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.owner.session')
    if (outcome === 'resolve') pending.resolve({ activationId, grantId })
    else pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    for (const id of ['record-condition', 'recovery-record-condition', 'receipt-record-condition', 'activation-receipt']) expect(query(id)).toBeNull()
    expect(api.grantDetail).not.toHaveBeenCalled()
  })
  it('does not infer a historical automatic grant condition mode from a current option', async () => {
    configureRecord()
    api.options.mockResolvedValue({ items: [{ ...recordOption(), recordCondition: {
      mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai',
    } }], nextCursor: null })
    api.listGrants.mockResolvedValue({ items: [grant({ purpose: 'automatic', triggers: ['record'] })], nextCursor: null })
    await mount(); await click('load'); await click('open-grant')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic record authorization')
    expect(query('receipt-record-condition')).toBeNull(); expect(query('recovery-record-condition')).toBeNull()
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it('a changed current option type clears confirmation even if its rule id is unchanged', async () => {
    configureRecord()
    const supplied = reactive(recordOption())
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    supplied.recordTriggerType = 'record.updated'; await flush()
    expect(query('record-trigger')?.getAttribute('data-record-trigger-type')).toBe('record.updated')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it('a changed rule revision clears confirmation even when the visible event type returns to the same value', async () => {
    configureRecord()
    const supplied = reactive(recordOption('record.updated'))
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    supplied.recordRuleRevision = nextRuleRevision; await flush()
    expect(query('record-trigger')?.getAttribute('data-record-trigger-type')).toBe('record.updated')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
    await input('record-confirm', true); await click('activate-record')
    expect(api.activateRecord.mock.calls[0][0].expectedRuleRevision).toBe(nextRuleRevision)
  })

  it('a server-ineligible conditional record rule cannot gain activation from allowedTriggers alone', async () => {
    api.options.mockResolvedValue({ items: [{ ...option, ruleName: 'Synthetic conditional record rule',
      allowedTriggers: ['manual', 'record'], recordActivationEligible: false, recordTriggerType: null }], nextCursor: null })
    await mount(); await prepareRecord(); await input('record-confirm', true)
    expect(query('record-trigger')?.textContent).toContain('Not confirmed by the server')
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it('updated activation recovery retains its original type for display but never self-reports it in the body', async () => {
    configureRecord({}, 'record.updated')
    api.activateRecord.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    expect(query('recovery-record-trigger')?.textContent).toContain('record.updated')
    expect(button('load').disabled).toBe(true)
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(Object.keys(original).sort()).toEqual(['activationKey', 'budget', 'expectedRecordCondition', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector'])
    expect(original.expectedRuleRevision).toBe(ruleRevision)
    expect(query('receipt-record-trigger')?.textContent).toContain('record.updated')
    expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['AUTOMATION_READ_INPUT_INVALID', 'AUTOMATION_READ_SCOPE_CHANGED'] as const)('record %s cannot switch a frozen revision/type/key or create replacement consent', async code => {
    configureRecord({}, 'record.updated')
    api.activateRecord.mockRejectedValue(new AutomationReadClientError(code))
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    api.options.mockResolvedValue({ items: [{ ...recordOption('record.created'), recordRuleRevision: nextRuleRevision }], nextCursor: null })
    await click('load'); await click('recover-activation')
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.activateRecord).toHaveBeenCalledTimes(2)
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(original.expectedRuleRevision).toBe(ruleRevision)
    expect(query('recovery-record-trigger')?.textContent).toContain('record.updated')
    expect(query('new-activation')).toBeNull()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('successful activation requires a separate new-consent action before any second independent budget', async () => {
    configureRecord()
    await mount(); await activate()
    expect(button('activate-record').disabled).toBe(true)
    await click('activate-record')
    await click('load'); await input('option', 'rule-one'); await input('record-confirm', true); await click('activate-record')
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    await click('new-activation')
    expect((query('record-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-record').disabled).toBe(true)
    expect(query('notice')?.textContent).toContain('earlier authorization is not automatically revoked')
    await input('record-confirm', true); await click('activate-record')
    expect(api.activateRecord).toHaveBeenCalledTimes(2)
    expect(api.activateRecord.mock.calls[1][0].activationKey).not.toBe(api.activateRecord.mock.calls[0][0].activationKey)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_RESPONSE_INVALID'] as const)('activation %s retains its exact frozen original body until explicit recovery', async code => {
    configureRecord()
    api.activateRecord.mockRejectedValueOnce(new AutomationReadClientError(code))
    await mount(); await activate(); await flush()
    const original = api.activateRecord.mock.calls[0][0]
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(query('activation-recovery')).not.toBeNull()
    expect(query('option')).toBeNull()
    expect(query('new-activation')).toBeNull()
    expect(button('load').disabled).toBe(true)
    expect(button('history-only').disabled).toBe(true)
    window.dispatchEvent(new StorageEvent('storage', { key: 'metasheet_locale', newValue: 'zh-CN' }))
    await flush(); await click('load'); await click('history-only')
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    await click('recover-activation')
    expect(api.activateRecord).toHaveBeenCalledTimes(2)
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(query('activation-recovery')).toBeNull()
    expect(query('activation-receipt')).not.toBeNull()
    expect(button('submit').disabled).toBe(true)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_DENIED', 'AUTOMATION_READ_RESPONSE_INVALID'] as const)('a successful activation POST followed by detail %s preserves the same command rather than creating replacement consent', async code => {
    configureRecord()
    api.grantDetail.mockRejectedValueOnce(new AutomationReadClientError(code))
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    expect(api.grantDetail).toHaveBeenCalledTimes(1)
    expect(query('activation-receipt')).toBeNull()
    expect(query('current-grant')).toBeNull()
    expect(query('activation-recovery')).not.toBeNull()
    await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(api.grantDetail).toHaveBeenCalledTimes(2)
    expect(query('activation-receipt')).not.toBeNull()
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it('awaiting activation locks the real inputs and recovery is unaffected by synthetic edits to their models', async () => {
    configureRecord()
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    expect((query('mode') as HTMLSelectElement).disabled).toBe(true)
    expect((query('option') as HTMLSelectElement).disabled).toBe(true)
    expect((query('ttl') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true)
    expect(button('load').disabled).toBe(true)
    expect(button('history-only').disabled).toBe(true)
    // Deliberately dispatch into a disabled field: this is not a possible user
    // edit, but isolates freezing the command from the separate DOM lock.
    await input('ttl', '100'); await input('executions', '99'); await input('budget-maxRows', '1')
    pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE')); await flush()
    await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(original.maxExecutions).toBe(1)
    expect(original.budget.maxRows).toBe(10)
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it.each((['record.created', 'record.updated'] as const).flatMap(trigger =>
    (['resolve', 'reject'] as const).map(outcome => ({ trigger, outcome }))))('activation $trigger discards a late $outcome after A→B→A without reintroducing consent or recovery', async ({ trigger, outcome }) => {
    configureRecord({}, trigger)
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.other.session')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.owner.session')
    if (outcome === 'resolve') pending.resolve({ activationId, grantId })
    else pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    for (const id of ['activation-receipt', 'activation-recovery', 'current-grant', 'new-activation', 'error']) expect(query(id)).toBeNull()
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
  })

  it('an in-flight updated consent retains its original revision and display type despite a changed options object', async () => {
    configureRecord({}, 'record.updated')
    const supplied = reactive(recordOption('record.updated'))
    api.options.mockResolvedValue({ items: [supplied], nextCursor: null })
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    expect((query('mode') as HTMLSelectElement).disabled).toBe(true)
    expect((query('option') as HTMLSelectElement).disabled).toBe(true)
    // A service-double change only isolates the immutable command. The real
    // server independently compares expectedRuleRevision under its rule lock.
    supplied.recordTriggerType = 'record.created'; supplied.recordRuleRevision = nextRuleRevision
    await flush()
    pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE')); await flush()
    expect(query('recovery-record-trigger')?.textContent).toContain('record.updated')
    await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(original.expectedRuleRevision).toBe(ruleRevision)
    expect(query('receipt-record-trigger')?.textContent).toContain('record.updated')
    expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
  })

  it.each(['projectNo', 'sheetId', 'scopeKey'] as const)('activation ignores a late receipt and clears the retained key after %s changes', async key => {
    configureRecord()
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    props[key] = 'other-synthetic-context'; await flush()
    pending.resolve({ activationId, grantId }); await flush()
    expect(query('activation-recovery')).toBeNull()
    expect(query('activation-receipt')).toBeNull()
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(api.dispose).toHaveBeenCalled()
  })

  it('an outgoing-session record consent cannot issue a POST after storage changes immediately before clicking', async () => {
    configureRecord()
    await mount(); await prepareRecord(); await input('record-confirm', true)
    localStorage.setItem('auth_token', 'synthetic.other.session')
    await click('activate-record')
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(query('activation-recovery')).toBeNull()
    expect(query('option')).toBeNull()
  })

  it('late detail after logout cannot present a successful activation receipt', async () => {
    configureRecord()
    const pending = deferred<AutomationReadGrant>()
    api.grantDetail.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    expect(api.grantDetail).toHaveBeenCalledTimes(1)
    localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' })); await flush()
    pending.resolve(grant({ purpose: 'automatic', triggers: ['record'] })); await flush()
    expect(query('activation-receipt')).toBeNull()
    expect(query('activation-recovery')).toBeNull()
    expect(query('current-grant')).toBeNull()
  })

  it.each(['record', 'schedule'] as const)('automatic %s history never permits manual submission even when a malformed service double includes manual', async trigger => {
    api.grantDetail.mockResolvedValue(grant({ purpose: 'automatic', triggers: ['manual', trigger] }))
    await mount(); await click('load'); await click('open-grant')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic')
    expect(button('submit').disabled).toBe(true)
    await click('submit')
    expect(api.submit).not.toHaveBeenCalled()
    await click('revoke')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
  })

  it.each(['load', 'history-only'])('%s opens schedule automatic history without calling it record authorization or permitting a manual start', async action => {
    const automatic = grant({ purpose: 'automatic', triggers: ['schedule'] })
    api.listGrants.mockResolvedValue({ items: [automatic], nextCursor: null })
    api.grantDetail.mockResolvedValue(automatic)
    if (action === 'history-only') props.sheetId = null
    await mount(); await click(action)
    expect(query('grant-row')?.textContent).toContain('Automatic schedule authorization')
    expect(query('grant-row')?.textContent).not.toContain('Automatic record authorization')
    await click('open-grant')
    expect(api.grantDetail.mock.calls).toEqual([[grantId]])
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic schedule authorization')
    expect(query('current-grant-purpose')?.textContent).not.toContain('Automatic record authorization')
    expect(query('activation-receipt')).toBeNull()
    expect(button('submit').disabled).toBe(true)
    await click('submit')
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(button('revoke').disabled).toBe(false)
    await click('revoke')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    expect(button('revoke').disabled).toBe(true)
    expect(button('submit').disabled).toBe(true)
    expect(query('current-grant')?.textContent).toContain('revoked')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic schedule authorization')
    expect(api.submit).not.toHaveBeenCalled()
    if (action === 'history-only') expect(api.options).not.toHaveBeenCalled()
  })

  it('a revoked schedule automatic history entry stays descriptive and never offers a start or repeat revoke', async () => {
    const automatic = grant({ purpose: 'automatic', triggers: ['schedule'], status: 'revoked' })
    api.listGrants.mockResolvedValue({ items: [automatic], nextCursor: null })
    api.grantDetail.mockResolvedValue(automatic)
    await mount(); await click('history-only'); await click('open-grant')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic schedule authorization')
    expect(query('current-grant-purpose')?.textContent).not.toContain('Automatic record authorization')
    expect(query('current-grant')?.textContent).toContain('revoked')
    expect(button('submit').disabled).toBe(true)
    expect(button('revoke').disabled).toBe(true)
    await click('submit'); await click('revoke')
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.revoke).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it('standalone historical record grants are not described as automatic activation', async () => {
    api.grantDetail.mockResolvedValue(grant({ purpose: 'standalone', triggers: ['record'] }))
    await mount(); await click('load'); await click('open-grant')
    expect(query('current-grant-purpose')?.textContent).toContain('Standalone authorization (not automatic activation)')
    expect(query('activation-receipt')).toBeNull()
    expect(button('submit').disabled).toBe(true)
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each([
    ['standalone purpose', { purpose: 'standalone' }], ['manual trigger', { triggers: ['manual'] }],
    ['extra project', { projects: ['PROJECT-SYNTHETIC', 'ANOTHER'] }], ['different project', { projects: ['ANOTHER'] }],
    ['different selector', { selector: { ...option.selector, actionId: 'other-action' } }],
    ['different count', { maxExecutions: 2 }], ['different budget', { budget: { ...option.budget, maxRows: 1 } }],
    ['different expiry', { expiresAt: '2099-01-01T00:00:00.000Z' }],
  ] satisfies [string, Partial<AutomationReadGrant>][])('activation does not reconcile a mismatched %s from a fake detail', async (_label, overrides) => {
    configureRecord(overrides)
    await mount(); await activate()
    expect(query('activation-receipt')).toBeNull()
    expect(query('current-grant')).toBeNull()
    expect(query('activation-recovery')).not.toBeNull()
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('a replayed revoked receipt is displayed as revoked, without claiming current effectiveness', async () => {
    configureRecord({ status: 'revoked' })
    api.activateRecord.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activate(); await click('recover-activation')
    expect(query('activation-receipt')?.textContent).toContain('revoked')
    expect(query('activation-receipt')?.textContent).toContain('does not prove the authorization is currently effective')
    expect(button('submit').disabled).toBe(true)
    expect(button('revoke').disabled).toBe(true)
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('a receipt recovered after its original expiry does not extend expiry or allow a manual read', async () => {
    configureRecord()
    api.activateRecord.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activate()
    const original = api.activateRecord.mock.calls[0][0]
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.expiresAt) + 1)
    await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(original)
    expect(query('activation-receipt')?.textContent).toContain(original.expiresAt)
    expect(button('submit').disabled).toBe(true)
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('record authorization revocation and record request cancellation remain independent management operations', async () => {
    configureRecord()
    api.listRequests.mockResolvedValue({ items: [request({ trigger: 'record' })], nextCursor: null })
    api.observe.mockResolvedValue({ requestId, status: 'running', result: null })
    await mount(); await activate(); await click('revoke'); await click('refresh-history'); await click('open-request'); await click('cancel')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    expect(query('activation-receipt')?.textContent).toContain('revoked')
    expect(api.cancel.mock.calls).toEqual([[requestId]])
    expect(query('status')?.textContent).toContain('Outcome unknown')
    expect(api.activateRecord).toHaveBeenCalledTimes(1)
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('schedule stays opt-in and submits only its seven frozen fields after explicit cron consent', async () => {
    configureSchedule()
    await mount()
    expect(api.activateSchedule).not.toHaveBeenCalled()
    await click('load')
    expect((query('mode') as HTMLSelectElement).value).toBe('manual')
    expect(query('activate-schedule')).toBeNull()
    await input('mode', 'schedule'); await input('option', 'rule-one')
    expect(button('activate-schedule').disabled).toBe(true)
    expect(query('schedule-scope')?.textContent).toContain('Only unconditional schedule.cron')
    expect(query('schedule-scope')?.textContent).toContain('loaded rule revision and exact definition')
    expect(query('schedule-scope')?.textContent).toContain('no catch-up')
    expect(query('schedule-scope')?.textContent).toContain('does not edit rules or enable conditions')
    expect(query('schedule-scope')?.textContent).toContain('No matching planned occurrence before expiry means no read')
    expect(query('schedule-scope')?.textContent).toContain('default 15 minutes may not cover a daily or monthly schedule')
    expect(query('create-grant')).toBeNull()
    expect(query('activate-record')).toBeNull()
    await click('activate-schedule')
    expect(api.activateSchedule).not.toHaveBeenCalled()
    await input('schedule-confirm', true)
    const before = Date.now()
    await click('activate-schedule')
    const actual = api.activateSchedule.mock.calls[0][0]
    expect(actual).toEqual({ activationKey: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      selector: option.selector, projectNo: 'PROJECT-SYNTHETIC', budget: option.budget, maxExecutions: 1, expiresAt: expect.any(String), expectedRuleRevision: ruleRevision })
    expect(Date.parse(actual.expiresAt)).toBeGreaterThanOrEqual(before + 900_000)
    expect(Date.parse(actual.expiresAt)).toBeLessThanOrEqual(Date.now() + 900_000)
    for (const value of [actual, actual.selector, actual.budget]) expect(Object.isFrozen(value)).toBe(true)
    expect(api.grantDetail.mock.calls).toEqual([[grantId]])
    expect(query('activation-receipt')?.getAttribute('data-activation-family')).toBe('schedule')
    expect(query('activation-receipt')?.textContent).toContain('Schedule activation registered')
    expect(query('activation-receipt')?.textContent).not.toContain('Record activation registered')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic schedule authorization')
    expect(button('submit').disabled).toBe(true)
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.observe).not.toHaveBeenCalled()
  })

  it('interval consent displays the exact fixed phase and posts only seven fields, never a client schedule', async () => {
    configureSchedule({}, intervalDefinition)
    await mount(); await click('load')
    expect((query('mode') as HTMLSelectElement).value).toBe('manual')
    expect(api.activateSchedule).not.toHaveBeenCalled()
    await input('mode', 'schedule'); await input('option', 'rule-one')
    expect(query('schedule-definition')?.getAttribute('data-schedule-trigger-type')).toBe('schedule.interval')
    const displayed = query('schedule-definition')?.textContent
    expect(displayed).toContain('I=1500 ms'); expect(displayed).toContain(`A=${intervalDefinition.anchorMs} ms`)
    expect(displayed).toContain(new Date(intervalDefinition.anchorMs).toISOString())
    for (const phrase of ['rule creation time floored to milliseconds', 'A+nI (n>=1', 'strictly later',
      'first wait may be shorter', 'no catch-up', 'does not edit rules or enable conditions']) expect(query('schedule-scope')?.textContent).toContain(phrase)
    await click('activate-schedule'); expect(api.activateSchedule).not.toHaveBeenCalled()
    await input('schedule-confirm', true); await click('activate-schedule')
    const body = api.activateSchedule.mock.calls[0][0]
    expect(Object.keys(body).sort()).toEqual(['activationKey', 'budget', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector'])
    expect(body.expectedRuleRevision).toBe(ruleRevision)
    expect(query('receipt-schedule-definition')?.textContent).toBe(displayed)
    expect(button('submit').disabled).toBe(true)
    expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })

  it.each([
    ['missing revision', { scheduleRuleRevision: undefined }], ['null revision', { scheduleRuleRevision: null }],
    ['bad revision', { scheduleRuleRevision: 'bad' }], ['noncanonical revision', { scheduleRuleRevision: ruleRevision.toUpperCase() }],
    ['missing definition', { scheduleDefinition: undefined }], ['null definition', { scheduleDefinition: null }],
    ['unknown type', { scheduleDefinition: { triggerType: 'schedule.date_field' } }],
    ['small interval', { scheduleDefinition: { ...intervalDefinition, intervalMs: 999 } }],
    ['large interval', { scheduleDefinition: { ...intervalDefinition, intervalMs: 2147483648 } }],
    ['fractional phase', { scheduleDefinition: { ...intervalDefinition, anchorMs: 1.5 } }],
    ['nondate phase', { scheduleDefinition: { ...intervalDefinition, anchorMs: Number.MAX_SAFE_INTEGER } }],
    ['wrong cron', { scheduleDefinition: { triggerType: 'schedule.cron', config: { cron: 'junk' } } }],
    ['expanded definition', { scheduleDefinition: { ...intervalDefinition, conditions: {} } }],
  ])('schedule guard rejects %s from a fake transport without creating consent', async (_label, overrides) => {
    configureSchedule({}, intervalDefinition)
    api.options.mockResolvedValue({ items: [{ ...scheduleOption(intervalDefinition), ...overrides }], nextCursor: null })
    await mount(); await prepareSchedule(); await input('schedule-confirm', true)
    expect(button('activate-schedule').disabled).toBe(true)
    await click('activate-schedule')
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each(['date', 'dateTime'] as const)('date consent displays the actual %s field/config and sends its frozen eight-key precondition', async fieldType => {
    const definition = { ...dateDefinition, dateField: { ...dateDefinition.dateField, fieldType } }
    configureSchedule({}, definition)
    await mount(); await prepareSchedule()
    expect(button('activate-schedule').disabled).toBe(true)
    const displayed = query('schedule-definition')?.textContent
    for (const text of ['schedule.date_field', 'due-date', `(${fieldType})`, 'before 3 days', '08:30 Asia/Shanghai', `schema=${ruleRevision}`]) expect(displayed).toContain(text)
    const scope = query('schedule-scope')?.textContent
    for (const text of ['Only unconditional schedule.date_field', 'original rule editor', 'Each eligible record occurrence consumes one read allowance',
      'Multiple records due on the same day', 'project is never derived from record content', 'strictly after this activation', 'scanning and catch-up are bounded',
      'Activation itself reads neither record dates nor the source']) expect(scope).toContain(text)
    expect(query('schedule-confirm')?.parentElement?.textContent).toContain('date field, type, schema revision, offset, time and timezone')
    expect(query('schedule-confirm')?.parentElement?.textContent).toContain('each eligible due record')
    await click('activate-schedule'); expect(api.activateSchedule).not.toHaveBeenCalled()
    await input('schedule-confirm', true); await click('activate-schedule')
    const actual = api.activateSchedule.mock.calls[0][0]
    expect(Object.keys(actual).sort()).toEqual(['activationKey', 'budget', 'expectedDateField', 'expectedRuleRevision', 'expiresAt', 'maxExecutions', 'projectNo', 'selector'])
    expect(actual.expectedDateField).toEqual(definition.dateField)
    expect(actual.expectedDateField).not.toBe(definition.dateField)
    expect(actual.projectNo).toBe('PROJECT-SYNTHETIC')
    expect(actual.expectedRuleRevision).toBe(ruleRevision)
    expect(Object.isFrozen(actual.expectedDateField)).toBe(true)
    expect(Object.isFrozen(actual)).toBe(true)
    expect(query('receipt-schedule-definition')?.textContent).toBe(displayed)
    expect(query('notice')?.textContent).toContain('Date activation receipt reconciled')
    expect(button('submit').disabled).toBe(true)
    expect(api.createGrant).not.toHaveBeenCalled(); expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })

  it('displays only documented absent date defaults and the after direction without adding them to consent', async () => {
    const definition = { ...dateDefinition, config: { dateFieldId: 'due-date', offsetDays: 0, direction: 'after' as const } }
    configureSchedule({}, definition)
    await mount(); await activateSchedule()
    expect(query('receipt-schedule-definition')?.textContent).toContain('after 0 days · 09:00 UTC')
    expect(api.activateSchedule.mock.calls[0][0]).not.toHaveProperty('config')
    expect(api.activateSchedule.mock.calls[0][0].expectedDateField).toEqual(dateDefinition.dateField)
  })

  it.each([
    { triggerType: 'schedule.date_field', config: dateDefinition.config },
    { ...dateDefinition, dateField: null },
    { ...dateDefinition, dateField: { ...dateDefinition.dateField, fieldId: 'other' } },
    { ...dateDefinition, dateField: { ...dateDefinition.dateField, fieldType: 'text' } },
    { ...dateDefinition, dateField: { ...dateDefinition.dateField, schemaRevision: 'bad' } },
    { ...dateDefinition, config: { ...dateDefinition.config, timezone: 'Bad/Zone' } },
    { ...dateDefinition, config: { ...dateDefinition.config, conditions: [] } },
  ])('malformed date option cannot enable activation or synthesize confirmation %#', async definition => {
    configureSchedule()
    api.options.mockResolvedValue({ items: [scheduleOption(definition as AutomationReadScheduleDefinition)], nextCursor: null })
    await mount(); await prepareSchedule(); await input('schedule-confirm', true); await click('activate-schedule')
    expect(button('activate-schedule').disabled).toBe(true)
    expect(query('schedule-definition')?.textContent).toContain('Schedule definition unconfirmed')
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each(['dateField', 'fieldType', 'schemaRevision', 'timezone'] as const)('date %s accessor is never invoked while rendering, tracking or constructing consent', async key => {
    const getter = vi.fn(() => 'date')
    const definition = { ...dateDefinition, config: { ...dateDefinition.config }, dateField: { ...dateDefinition.dateField } }
    const subject = key === 'dateField' ? definition : key === 'timezone' ? definition.config : definition.dateField
    Object.defineProperty(subject, key, { enumerable: true, get: getter })
    configureSchedule({}, definition)
    await mount(); await prepareSchedule(); await input('schedule-confirm', true); await click('activate-schedule')
    expect(getter).not.toHaveBeenCalled(); expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(button('activate-schedule').disabled).toBe(true)
  })

  it.each(['fieldId', 'fieldType', 'schemaRevision', 'dateFieldId', 'offsetDays', 'direction', 'timeOfDay', 'timezone', 'effectiveAt', 'scanIntervalMs'] as const)(
    'date %s A→B→A clears the checkbox synchronously, including newly added optional metadata', async key => {
      const definition = reactive({ ...dateDefinition, config: { ...dateDefinition.config }, dateField: { ...dateDefinition.dateField } })
      configureSchedule({}, definition)
      await mount(); await prepareSchedule(); await input('schedule-confirm', true)
      expect(button('activate-schedule').disabled).toBe(false)
      const subject = key === 'fieldId' || key === 'fieldType' || key === 'schemaRevision' ? definition.dateField : definition.config
      const before = Object.getOwnPropertyDescriptor(subject, key)
      const changed = { fieldId: 'changed', fieldType: 'dateTime', schemaRevision: nextRuleRevision, dateFieldId: 'changed',
        offsetDays: 4, direction: 'after', timeOfDay: '10:00', timezone: 'UTC', effectiveAt: '2026-10-02T00:00:00.000Z', scanIntervalMs: 60000 }[key]
      Reflect.set(subject, key, changed)
      if (before) Reflect.set(subject, key, before.value)
      else Reflect.deleteProperty(subject, key)
      await flush()
      expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
      expect(button('activate-schedule').disabled).toBe(true)
      expect(api.activateSchedule).not.toHaveBeenCalled()
    },
  )

  it.each(['post', 'detail'] as const)('lost date %s receipt recovers original field/type/schema/config/key, never the changed selection', async stage => {
    const definition = reactive({ ...dateDefinition, config: { ...dateDefinition.config }, dateField: { ...dateDefinition.dateField } })
    configureSchedule({}, definition)
    if (stage === 'post') api.activateSchedule.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    else api.grantDetail.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    expect(query('activation-recovery')).not.toBeNull()
    expect(query('recovery-schedule-definition')?.textContent).toContain('before 3 days · 08:30 Asia/Shanghai')
    Reflect.set(definition.dateField, 'fieldType', 'dateTime')
    definition.dateField.schemaRevision = nextRuleRevision
    definition.config.timezone = 'UTC'; definition.config.offsetDays = 7
    await flush(); await click('recover-activation')
    expect(api.activateSchedule.mock.calls[1][0]).toBe(original)
    expect(original.expectedDateField).toEqual(dateDefinition.dateField)
    expect(original.expectedRuleRevision).toBe(ruleRevision)
    expect(query('receipt-schedule-definition')?.textContent).toContain('(date)')
    expect(query('receipt-schedule-definition')?.textContent).toContain(`schema=${ruleRevision}`)
    expect(query('receipt-schedule-definition')?.textContent).toContain('before 3 days · 08:30 Asia/Shanghai')
    expect(api.options).toHaveBeenCalledTimes(1)
    expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  })

  it('never invokes a schedule definition getter to render or track confirmation', async () => {
    configureSchedule({}, intervalDefinition)
    const getter = vi.fn(() => 1500)
    api.options.mockResolvedValue({ items: [scheduleOption(Object.defineProperty({ ...intervalDefinition }, 'intervalMs', { enumerable: true, get: getter }))], nextCursor: null })
    await mount(); await prepareSchedule(); await input('schedule-confirm', true); await click('activate-schedule')
    expect(getter).not.toHaveBeenCalled(); expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each(['revision', 'interval', 'phase', 'type', 'cron', 'timezone'] as const)('schedule %s A→B→A clears confirmation without waiting for another load', async field => {
    configureSchedule()
    const candidate = reactive(scheduleOption(field === 'cron' || field === 'timezone' ? undefined : { ...intervalDefinition }))
    api.options.mockResolvedValue({ items: [candidate], nextCursor: null })
    await mount(); await prepareSchedule(); await input('schedule-confirm', true)
    expect(button('activate-schedule').disabled).toBe(false)
    if (field === 'revision') { candidate.scheduleRuleRevision = nextRuleRevision; candidate.scheduleRuleRevision = ruleRevision }
    else if (field === 'type') {
      const original = candidate.scheduleDefinition
      candidate.scheduleDefinition = { triggerType: 'schedule.cron', config: { cron: '* * * * *' } }
      candidate.scheduleDefinition = original
    } else if (field === 'cron' || field === 'timezone') {
      const definition = candidate.scheduleDefinition
      if (definition?.triggerType !== 'schedule.cron') throw new Error('SYNTHETIC_CRON_EXPECTED')
      const key = field === 'cron' ? 'cron' : 'timezone', original = Reflect.get(definition.config, key)
      Reflect.set(definition.config, key, field === 'cron' ? '0 8 * * *' : 'Asia/Shanghai')
      Reflect.set(definition.config, key, original)
    } else {
      const definition = candidate.scheduleDefinition
      if (definition?.triggerType !== 'schedule.interval') throw new Error('SYNTHETIC_INTERVAL_EXPECTED')
      const key = field === 'interval' ? 'intervalMs' : 'anchorMs', original = definition[key]
      Reflect.set(definition, key, original + 1); Reflect.set(definition, key, original)
    }
    await flush()
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-schedule').disabled).toBe(true)
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each(['AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_INPUT_INVALID', 'AUTOMATION_READ_SCOPE_CHANGED', 'detail'] as const)(
    'interval %s recovery keeps the original revision, phase and key after options change', async failure => {
      configureSchedule({}, intervalDefinition)
      const candidate = reactive(scheduleOption({ ...intervalDefinition }))
      api.options.mockResolvedValue({ items: [candidate], nextCursor: null })
      if (failure === 'detail') api.grantDetail.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
      else api.activateSchedule.mockRejectedValueOnce(new AutomationReadClientError(failure))
      await mount(); await activateSchedule()
      const original = api.activateSchedule.mock.calls[0][0]
      expect(query('recovery-schedule-definition')?.textContent).toContain('I=1500 ms')
      candidate.scheduleRuleRevision = nextRuleRevision
      candidate.scheduleDefinition = { triggerType: 'schedule.cron', config: { expression: '0 8 * * *' } }
      await flush(); await click('recover-activation')
      expect(api.activateSchedule.mock.calls[1][0]).toBe(original)
      expect(original.expectedRuleRevision).toBe(ruleRevision)
      expect(query('receipt-schedule-definition')?.textContent).toContain('I=1500 ms')
      expect(query('receipt-schedule-definition')?.textContent).toContain(`A=${intervalDefinition.anchorMs} ms`)
      expect(api.options).toHaveBeenCalledTimes(1)
      expect(api.activateRecord).not.toHaveBeenCalled(); expect(api.createGrant).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
    },
  )

  it.each(['resolve', 'reject'] as const)('pending interval retains its frozen phase on late %s and cannot follow disabled controls', async outcome => {
    configureSchedule({}, intervalDefinition)
    const candidate = reactive(scheduleOption({ ...intervalDefinition })), pending = deferred<{ activationId: string; grantId: string }>()
    api.options.mockResolvedValue({ items: [candidate], nextCursor: null }); api.activateSchedule.mockReturnValueOnce(pending.promise)
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    expect((query('mode') as HTMLSelectElement).disabled).toBe(true)
    candidate.scheduleRuleRevision = nextRuleRevision
    candidate.scheduleDefinition = { ...intervalDefinition, intervalMs: 60_000, anchorMs: intervalDefinition.anchorMs + 1 }
    await input('ttl', '100'); await input('mode', 'record')
    if (outcome === 'resolve') pending.resolve({ activationId, grantId })
    else pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    if (outcome === 'reject') await click('recover-activation')
    expect(query('receipt-schedule-definition')?.textContent).toContain('I=1500 ms')
    expect(query('receipt-schedule-definition')?.textContent).toContain(`A=${intervalDefinition.anchorMs} ms`)
    expect(api.activateSchedule.mock.calls.at(-1)?.[0]).toBe(original)
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('interval session ABA discards a late %s and its displayed phase', async outcome => {
    configureSchedule({}, intervalDefinition)
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateSchedule.mockReturnValueOnce(pending.promise)
    await mount(); await activateSchedule()
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.other.session')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.owner.session')
    if (outcome === 'resolve') pending.resolve({ activationId, grantId })
    else pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    for (const id of ['schedule-definition', 'receipt-schedule-definition', 'recovery-schedule-definition', 'activation-receipt']) expect(query(id)).toBeNull()
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
  })

  it('schedule history does not borrow a currently visible interval definition as historical consent', async () => {
    configureSchedule({}, intervalDefinition)
    const historical = grant({ purpose: 'automatic', triggers: ['schedule'] })
    api.listGrants.mockResolvedValue({ items: [historical], nextCursor: null }); api.grantDetail.mockResolvedValue(historical)
    await mount(); await click('load'); await click('open-grant')
    expect(query('current-grant-purpose')?.textContent).toContain('Automatic schedule authorization')
    expect(query('current-grant-purpose')?.textContent).not.toContain('interval')
    expect(query('receipt-schedule-definition')).toBeNull()
    expect(query('recovery-schedule-definition')).toBeNull()
    expect(button('submit').disabled).toBe(true)
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each([
    ['false eligibility', { scheduleActivationEligible: false }],
    ['missing eligibility', { scheduleActivationEligible: undefined }],
    ['truthy eligibility', { scheduleActivationEligible: 'true' }],
    ['both families eligible', { recordActivationEligible: true }],
    ['wrong trigger', { allowedTriggers: ['record'] }],
  ])('schedule blocks %s from a malformed service double without calling an activation endpoint', async (_label, overrides) => {
    configureSchedule()
    api.options.mockResolvedValue({ items: [{ ...scheduleOption(), ...overrides }], nextCursor: null })
    await mount(); await prepareSchedule(); await input('schedule-confirm', true)
    expect(host.querySelector<HTMLOptionElement>('option[value="rule-one"]')?.disabled).toBe(true)
    expect(button('activate-schedule').disabled).toBe(true)
    await click('activate-schedule')
    expect(api.activateSchedule).not.toHaveBeenCalled()
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each(['ttl', 'executions', 'budget-maxRows', 'budget-maxPages', 'budget-maxReadCount', 'budget-timeoutMs'])('changing schedule %s clears explicit confirmation', async field => {
    configureSchedule()
    await mount(); await prepareSchedule(); await input('schedule-confirm', true)
    expect(button('activate-schedule').disabled).toBe(false)
    await input(field, field === 'ttl' ? '14' : field === 'budget-maxPages' ? '1' : '2')
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-schedule').disabled).toBe(true)
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it('switching rule or family never carries confirmation into cron activation', async () => {
    configureSchedule()
    api.options.mockResolvedValue({ items: [{ ...scheduleOption(), allowedTriggers: ['manual', 'schedule'] },
      { ...scheduleOption(), selector: { ...option.selector, ruleId: 'rule-two' } }], nextCursor: null })
    await mount(); await click('load'); await input('option', 'rule-one'); await input('grant-confirm', true)
    await input('mode', 'schedule'); await input('option', 'rule-one')
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    await input('schedule-confirm', true); await input('option', 'rule-two')
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    await input('schedule-confirm', true); await input('mode', 'record'); await input('mode', 'schedule'); await input('option', 'rule-one')
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    expect(api.activateSchedule).not.toHaveBeenCalled()
  })

  it.each(['post', 'detail', 'wrong-family-detail'] as const)('unconfirmed schedule %s recovers only the original family, key and complete body', async stage => {
    configureSchedule(stage === 'wrong-family-detail' ? { triggers: ['record'] } : {})
    if (stage === 'post') api.activateSchedule.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    if (stage === 'detail') api.grantDetail.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_DENIED'))
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    expect(query('activation-recovery')?.textContent).toContain('Schedule activation is unconfirmed')
    expect(query('activation-receipt')).toBeNull()
    expect(query('current-grant')).toBeNull()
    expect(query('mode')).toBeNull()
    expect(button('load').disabled).toBe(true)
    expect(button('history-only').disabled).toBe(true)
    expect(query('new-activation')).toBeNull()
    await flush()
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
    configureSchedule()
    await click('recover-activation')
    expect(api.activateSchedule).toHaveBeenCalledTimes(2)
    expect(api.activateSchedule.mock.calls[1][0]).toBe(original)
    expect(query('activation-receipt')?.getAttribute('data-activation-family')).toBe('schedule')
    expect(query('activation-recovery')).toBeNull()
    expect(api.activateRecord).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    expect(api.submit).not.toHaveBeenCalled()
  })

  it.each(['record', 'schedule'] as const)('pending %s freezes its endpoint even under synthetic edits to the disabled mode', async family => {
    if (family === 'record') configureRecord(); else configureSchedule()
    const endpoint = family === 'record' ? api.activateRecord : api.activateSchedule
    const other = family === 'record' ? api.activateSchedule : api.activateRecord
    const pending = deferred<{ activationId: string; grantId: string }>()
    endpoint.mockReturnValueOnce(pending.promise)
    await mount()
    if (family === 'record') await activate(); else await activateSchedule()
    const original = endpoint.mock.calls[0][0]
    expect((query('mode') as HTMLSelectElement).disabled).toBe(true)
    expect((query('ttl') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true)
    // Unavailable to a real user; isolate the frozen family from the DOM lock.
    await input('ttl', '100'); await input('executions', '99')
    await input('mode', family === 'record' ? 'schedule' : 'record')
    pending.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE')); await flush()
    await click('recover-activation')
    expect(endpoint).toHaveBeenCalledTimes(2)
    expect(endpoint.mock.calls[1][0]).toBe(original)
    expect(original.maxExecutions).toBe(1)
    expect(query('activation-receipt')?.getAttribute('data-activation-family')).toBe(family)
    expect(other).not.toHaveBeenCalled()
  })

  it('a record command rejects a schedule detail instead of adopting the other family', async () => {
    configureRecord({ triggers: ['schedule'] })
    await mount(); await activate()
    expect(query('activation-recovery')?.textContent).toContain('Record activation is unconfirmed')
    expect(query('activation-receipt')).toBeNull()
    expect(api.activateSchedule).not.toHaveBeenCalled()
    configureRecord(); await click('recover-activation')
    expect(api.activateRecord.mock.calls[1][0]).toBe(api.activateRecord.mock.calls[0][0])
    expect(query('activation-receipt')?.getAttribute('data-activation-family')).toBe('record')
  })

  it('schedule double clicks and spent confirmation cannot create another budget, even after a family switch', async () => {
    configureSchedule()
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateSchedule.mockReturnValueOnce(pending.promise)
    await mount(); await prepareSchedule(); await input('schedule-confirm', true)
    button('activate-schedule').click(); button('activate-schedule').click(); await flush()
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
    pending.resolve({ activationId, grantId }); await flush()
    await input('mode', 'record'); await input('mode', 'schedule'); await input('option', 'rule-one')
    await input('schedule-confirm', true); await click('activate-schedule')
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
    await click('new-activation')
    expect((query('schedule-confirm') as HTMLInputElement).checked).toBe(false)
    expect(button('activate-schedule').disabled).toBe(true)
    await input('schedule-confirm', true); await click('activate-schedule')
    expect(api.activateSchedule).toHaveBeenCalledTimes(2)
    expect(api.activateSchedule.mock.calls[1][0].activationKey).not.toBe(api.activateSchedule.mock.calls[0][0].activationKey)
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each([
    ['post', 'resolve'], ['post', 'reject'], ['detail', 'resolve'], ['detail', 'reject'],
  ] as const)('schedule %s late %s after session A→B→A cannot restore receipt, recovery or metadata', async (stage, outcome) => {
    configureSchedule()
    const pendingPost = deferred<{ activationId: string; grantId: string }>(), pendingDetail = deferred<AutomationReadGrant>()
    if (stage === 'post') api.activateSchedule.mockReturnValueOnce(pendingPost.promise)
    else api.grantDetail.mockReturnValueOnce(pendingDetail.promise)
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.other.session')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic.owner.session')
    if (stage === 'post') {
      if (outcome === 'resolve') pendingPost.resolve({ activationId, grantId })
      else pendingPost.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    } else if (outcome === 'resolve') pendingDetail.resolve(scheduleGrant(original))
    else pendingDetail.reject(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await flush()
    for (const id of ['activation-receipt', 'activation-recovery', 'current-grant', 'new-activation', 'error']) expect(query(id)).toBeNull()
    expect(api.grantDetail).toHaveBeenCalledTimes(stage === 'post' ? 0 : 1)
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
    expect(api.activateRecord).not.toHaveBeenCalled()
  })

  it.each(['projectNo', 'sheetId', 'scopeKey'] as const)('schedule clears frozen recovery on %s changes and ignores late detail', async key => {
    configureSchedule()
    const pending = deferred<AutomationReadGrant>()
    api.grantDetail.mockReturnValueOnce(pending.promise)
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    props[key] = 'other-synthetic-context'; await flush()
    pending.resolve(scheduleGrant(original)); await flush()
    expect(query('activation-recovery')).toBeNull()
    expect(query('activation-receipt')).toBeNull()
    expect(query('current-grant')).toBeNull()
    expect(api.dispose).toHaveBeenCalled()
    expect(api.activateSchedule).toHaveBeenCalledTimes(1)
  })

  it.each(['revoked', 'expired'] as const)('recovered %s schedule receipt stays descriptive and cannot start manually', async state => {
    configureSchedule(state === 'revoked' ? { status: 'revoked' } : {})
    api.activateSchedule.mockRejectedValueOnce(new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE'))
    await mount(); await activateSchedule()
    const original = api.activateSchedule.mock.calls[0][0]
    if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.expiresAt) + 1)
    await click('recover-activation')
    expect(api.activateSchedule).toHaveBeenCalledTimes(2)
    expect(api.activateSchedule.mock.calls[1][0]).toBe(original)
    expect(query('activation-receipt')?.textContent).toContain(original.expiresAt)
    expect(query('activation-receipt')?.textContent).toContain('does not prove the authorization is currently effective')
    if (state === 'revoked') expect(query('activation-receipt')?.textContent).toContain('revoked')
    expect(button('submit').disabled).toBe(true)
    expect(api.submit).not.toHaveBeenCalled()
  })

  it('schedule revoke and request cancel stay management-only and unmount drops a pending receipt', async () => {
    configureSchedule()
    api.listRequests.mockResolvedValue({ items: [request({ trigger: 'schedule' })], nextCursor: null })
    api.observe.mockResolvedValue({ requestId, status: 'running', result: null })
    await mount(); await activateSchedule(); await click('revoke'); await click('refresh-history'); await click('open-request'); await click('cancel')
    expect(api.revoke.mock.calls).toEqual([[grantId]])
    expect(api.cancel.mock.calls).toEqual([[requestId]])
    expect(query('activation-receipt')?.textContent).toContain('revoked')
    expect(api.submit).not.toHaveBeenCalled()
    expect(api.createGrant).not.toHaveBeenCalled()
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateSchedule.mockReturnValueOnce(pending.promise)
    await click('new-activation'); await input('schedule-confirm', true); await click('activate-schedule')
    expect(api.activateSchedule).toHaveBeenCalledTimes(2)
    app!.unmount(); app = null
    pending.resolve({ activationId, grantId }); await flush()
    expect(api.grantDetail).toHaveBeenCalledTimes(1)
    expect(host.childNodes).toHaveLength(0)
  })

  it('unmount discards unresolved activation and a late response cannot read its grant detail', async () => {
    configureRecord()
    const pending = deferred<{ activationId: string; grantId: string }>()
    api.activateRecord.mockReturnValueOnce(pending.promise)
    await mount(); await activate()
    app!.unmount(); app = null
    pending.resolve({ activationId, grantId }); await flush()
    expect(api.grantDetail).not.toHaveBeenCalled()
    expect(api.dispose).toHaveBeenCalledTimes(1)
    expect(host.childNodes).toHaveLength(0)
  })

  it('unmount disposes the client; a late load response cannot reopen anything', async () => {
    const pending = deferred<{ items: AutomationReadOption[]; nextCursor: null }>()
    api.options.mockReturnValueOnce(pending.promise)
    await mount(); await click('load')
    app!.unmount(); app = null
    pending.resolve({ items: [option], nextCursor: null }); await flush()
    expect(api.dispose).toHaveBeenCalledTimes(1)
    expect(host.childNodes).toHaveLength(0)
    expect(query('panel')).toBeNull()
  })
})
