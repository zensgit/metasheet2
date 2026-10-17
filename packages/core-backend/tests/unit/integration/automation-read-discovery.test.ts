/** Sequencing and closed-projection unit checks only. The SQL handle and full
 * execution authority are explicit synthetic doubles, not authorization proof.
 * Production joins/full metadata authority are exercised in the real-PG suite. */
import { describe, expect, it, vi } from 'vitest'
import { createAutomationReadDiscovery } from '../../../src/integration/automation-read-discovery'
import { AutomationReadLedgerError, type AutomationReadLedgerDependencies, type ReadSelector, type ReadRecordCondition } from '../../../src/integration/automation-read-contracts'
import type { AutomationIntegrationActor } from '../../../src/integration/automation-live-authority'

const actor: AutomationIntegrationActor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const producer = { generation: '1', nonce: '11111111-1111-4111-8111-111111111111' }
const ruleRevision = '22222222-2222-4222-8222-222222222222'
const nextRuleRevision = '33333333-3333-4333-8333-333333333333'
const budget = { maxRows: 10, maxPages: 2, maxReadCount: 4, timeoutMs: 1000 }
const cronConfig = () => ({ expression: '0 9 * * *', timezone: 'UTC' })
const hint = (ruleId = 'synthetic-rule-1'): ReadSelector => ({ ruleId, actionId: 'plm.stock-preparation.pull-bom.v1', systemId: 'synthetic-system', targetId: producer.nonce })
const proof = () => ({ ...actor, key: 'a'.repeat(64), budget: { ...budget },
  allowedTriggers: ['manual', 'record'], sourceReference: { connectionId: 'synthetic-connection', connectionIncarnation: producer.nonce } })
function fixture() {
  const state = { rows: [hint()] as unknown[], cursor: [hint('synthetic-cursor')] as unknown[], name: 'Synthetic preview' as string | null,
    triggerType: 'record.created', triggerConfig: {} as unknown, conditions: null as unknown, ruleRevision: ruleRevision as unknown,
    intervalAnchorMs: null as unknown,
    metadataByRule: new Map<string, Record<string, unknown>>(),
    admin: true, live: true, afterLive: true, generation: '1', membership: true, isolation: 'read committed' }
  const events: string[] = [], sql: Array<{ statement: string; params?: unknown[] }> = []
  let fences = 0
  const query = vi.fn(async (statement: string, params?: unknown[]) => {
    sql.push({ statement, params })
    if (statement.includes('transaction_isolation')) return { rows: [{ isolation: state.isolation }] }
    if (statement.includes('pg_current_xact_id')) return { rows: [{ xid: '101' }] }
    if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'integration_admin' }] }
    if (statement.includes('FROM role_permissions')) return { rows: state.admin ? [{ role_id: 'integration_admin', permission_code: 'integration:admin' }] : [] }
    if (statement.includes('FROM user_permissions')) return { rows: [] }
    if (statement.includes('FROM users')) return { rows: [{ id: actor.actorId, role: 'user', is_active: true, activation_status: 'activated', permissions: [] }] }
    if (statement.includes('FROM user_orgs')) return { rows: state.membership ? [{ user_id: actor.actorId, org_id: actor.tenantId, is_active: true }] : [] }
    if (statement.includes('FROM user_namespace_admissions')) return { rows: [{ namespace: 'integration', enabled: true }] }
    if (statement.includes("current_setting('lock_timeout')")) return { rows: [{ previous: '0', timeout_ms: '0' }] }
    if (statement.includes("set_config('lock_timeout'")) return { rows: [] }
    if (statement.includes('FROM automation_read_producer_slot')) {
      if (statement.includes('FOR SHARE')) return { rows: [{ generation: state.generation, nonce: producer.nonce }] }
      events.push('fence'); fences++
      return { rows: [{ generation: state.generation, nonce: producer.nonce, live: fences === 1 ? state.live : state.afterLive }] }
    }
    if (statement.includes('SELECT r.id AS')) {
      events.push(statement.includes('AND r.id=$6') ? 'cursor' : 'candidates')
      return { rows: statement.includes('AND r.id=$6') ? state.cursor : state.rows }
    }
    if (statement.includes('SELECT name,trigger_type,trigger_config,conditions,') && statement.includes('FROM automation_rules')) {
      events.push(`name:${params?.[0]}`)
      return { rows: [{ name: state.name, trigger_type: state.triggerType, trigger_config: state.triggerConfig,
        conditions: state.conditions, rule_revision: state.ruleRevision, interval_anchor_ms: state.intervalAnchorMs,
        ...state.metadataByRule.get(String(params?.[0])) }] }
    }
    throw new Error('Unexpected synthetic query')
  })
  const transaction = vi.fn(async work => work({ query, isTransaction: true })) as unknown as AutomationReadLedgerDependencies['transaction']
  const lockExecution = vi.fn(async (_trx, _actor, selector: ReadSelector) => { events.push(`proof:${selector.ruleId}`); return proof() })
  const descriptors = new WeakMap<object, ReadRecordCondition>()
  const lockRecordExecution = vi.fn(async (_trx, _actor, selector: ReadSelector) => {
    const value = proof(), conditions = state.metadataByRule.get(selector.ruleId)?.conditions ?? state.conditions
    descriptors.set(value, conditions === null ? { mode: 'unconditional' } : {
      mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai',
    })
    return value
  })
  const recordConditionFor = vi.fn(value => {
    const result = descriptors.get(value)
    if (!result) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
    return result
  })
  const authority = { lockExecution, lockRecordExecution, recordConditionFor, evaluateRecordConditions: vi.fn(), lockObservation: vi.fn() } as unknown as AutomationReadLedgerDependencies['authority']
  const discovery = createAutomationReadDiscovery({ transaction, authority, producer })
  return { discovery, state, events, sql, query, transaction, lockExecution, lockRecordExecution, recordConditionFor, authority }
}

describe('owner-only Automation selector discovery: synthetic ordering evidence', () => {
  it.each(['record.created', 'record.updated'])('prepares %s conditions and fetches a detached descriptor only from the original record proof', async triggerType => {
    const f = fixture(); f.state.triggerType = triggerType
    f.state.conditions = { conjunction: 'AND', conditions: [{ fieldId: 'private-field', operator: 'eq', value: 'private-literal' }] }
    const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    const original = await f.lockRecordExecution.mock.results[0].value
    expect(f.recordConditionFor).toHaveBeenCalledWith(original)
    expect(f.recordConditionFor.mock.calls[0][0]).toBe(original)
    expect(f.lockRecordExecution.mock.calls[0][0]).toBe(f.lockExecution.mock.calls[0][0])
    expect(page.items[0].recordCondition).toEqual({ mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Asia/Shanghai' })
    expect(JSON.stringify(page)).not.toMatch(/private-field|private-literal|fingerprint|sourceReference|"key"/)
    expect(page.items[0].recordCondition).not.toBe(f.recordConditionFor.mock.results[0].value)
    expect(Object.isFrozen(page.items[0].recordCondition)).toBe(true)
    expect(f.authority.evaluateRecordConditions).not.toHaveBeenCalled()
  })
  it.each(['lockRecordExecution', 'recordConditionFor', 'evaluateRecordConditions'] as const)(
    'cannot advertise record activation when the real %s capability is missing', async key => {
      const f = fixture(); delete f.authority[key]
      await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    },
  )
  it.each([new Error('private SQL failure'), { code: '55P03', message: 'private lock failure' },
    new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE'), new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')])(
    'never downgrades failed actual record preparation to a selectable conditional rule %#', async failure => {
      const f = fixture(); f.lockRecordExecution.mockRejectedValueOnce(failure)
      await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toBeTruthy()
      expect(f.recordConditionFor).not.toHaveBeenCalled()
    },
  )
  it('does not downgrade descriptor lookup denial, since it means the original proof was not recognized', async () => {
    const f = fixture(); f.recordConditionFor.mockImplementationOnce(() => { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') })
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
  })
  it.each([{ mode: 'unconditional', condition: 'private' }, { mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'Invalid/Zone' },
    { mode: 'saved_conditions', schemaRevision: ruleRevision, businessTimeZone: 'UTC' }])(
    'rejects malformed or rule-mode-inconsistent prepared descriptors %#', async descriptor => {
      const f = fixture(); f.recordConditionFor.mockReturnValueOnce(descriptor as ReadRecordCondition)
      await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toBeTruthy()
    },
  )
  function scheduleFixture() {
    const f = fixture()
    f.state.triggerType = 'schedule.cron'; f.state.triggerConfig = cronConfig()
    f.lockExecution.mockResolvedValue({ ...proof(), allowedTriggers: ['schedule'] })
    return f
  }
  it('authorizes every candidate before names and returns only detached fixed data', async () => {
    const f = fixture(), supplied = proof(); f.lockExecution.mockResolvedValue(supplied)
    const result = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    expect(result).toEqual({ items: [{ selector: hint(), ruleName: 'Synthetic preview', budget,
      allowedTriggers: ['manual', 'record'], recordActivationEligible: true, scheduleActivationEligible: false,
      recordTriggerType: 'record.created', recordRuleRevision: ruleRevision, recordCondition: { mode: 'unconditional' },
      scheduleRuleRevision: null, scheduleDefinition: null }], nextCursor: null })
    expect(f.lockExecution).toHaveBeenCalledTimes(1)
    expect(f.lockExecution).toHaveBeenCalledWith(expect.anything(), actor, hint())
    expect(f.events).toEqual(['fence', 'candidates', 'name:synthetic-rule-1', 'fence'])
    supplied.budget.maxRows = 999; supplied.allowedTriggers.splice(0)
    expect(result.items[0].budget.maxRows).toBe(10); expect(result.items[0].allowedTriggers).toEqual(['manual', 'record'])
    expect(f.authority.lockObservation).not.toHaveBeenCalled()
    expect(f.sql.every(call => /^\s*SELECT/u.test(call.statement))).toBe(true)
    expect(f.sql.some(call => /\bmeta_records\b|\bconfig\b|\bcredentials_encrypted\b/u.test(call.statement))).toBe(false)
  })
  it('proves cursor, items and limit+1 under the same actor and caps the returned page', async () => {
    const f = fixture(); f.state.rows = [hint('synthetic-rule-1'), hint('synthetic-rule-2')]
    f.state.metadataByRule.set('synthetic-cursor', { conditions: { conjunction: 'AND', conditions: [] } })
    f.state.metadataByRule.set('synthetic-rule-1', { trigger_type: 'record.updated' })
    const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet', limit: 1, after: 'synthetic-cursor' })
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBe('synthetic-rule-1')
    expect(page.items[0]).toMatchObject({ selector: hint('synthetic-rule-1'), recordActivationEligible: true,
      recordTriggerType: 'record.updated', recordRuleRevision: ruleRevision })
    expect(f.lockExecution.mock.calls.map(call => call[2].ruleId)).toEqual(['synthetic-cursor', 'synthetic-rule-1', 'synthetic-rule-2'])
    expect(f.events).toEqual(['fence', 'cursor', 'proof:synthetic-cursor', 'name:synthetic-cursor', 'candidates',
      'proof:synthetic-rule-1', 'name:synthetic-rule-1', 'proof:synthetic-rule-2', 'name:synthetic-rule-2', 'fence'])
    expect(f.sql.find(call => call.statement.includes('ORDER BY r.id'))?.params).toEqual([actor.actorId, actor.tenantId,
      producer.generation, producer.nonce, 'synthetic-sheet', 'synthetic-cursor', 2])
  })
  for (const allowManual of [false, true]) {
    it.each(['record.created', 'record.updated', 'record.deleted', 'field.value_changed'])(
      `derives exact record activation eligibility independently of manual opt-in (${allowManual}): %s`, async triggerType => {
        const f = fixture(), supplied = proof()
        f.state.triggerType = triggerType
        supplied.allowedTriggers = allowManual ? ['manual', 'record'] : ['record']
        f.lockExecution.mockResolvedValue(supplied)
        const result = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
        expect(result.items).toHaveLength(1)
        const eligible = triggerType === 'record.created' || triggerType === 'record.updated'
        expect(result.items[0]).toMatchObject({ allowedTriggers: supplied.allowedTriggers,
          recordActivationEligible: eligible, scheduleActivationEligible: false,
          recordTriggerType: eligible ? triggerType : null, recordRuleRevision: eligible ? ruleRevision : null })
      },
    )
  }
  it.each([null, {}, Object.create(null) as Record<string, unknown>])(
    'accepts only null or a plain empty trigger config for record activation %#', async triggerConfig => {
      const f = fixture(); f.state.triggerConfig = triggerConfig
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0]).toMatchObject({ recordActivationEligible: true,
        recordTriggerType: 'record.created', recordRuleRevision: ruleRevision })
    },
  )
  it.each([undefined, [], false, 0, '{}', 'null', { fieldId: 'synthetic-field' },
    Object.create({ fieldId: 'synthetic-field' }) as Record<string, unknown>].map(value => ({ value })))(
    'does not treat nonempty/nonobject trigger config as unconditional %#', async ({ value }) => {
      const f = fixture(); f.state.triggerConfig = value
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, recordTriggerType: null, recordRuleRevision: null })
    },
  )
  it.each([undefined, {}, [], false, '', 'null', { conjunction: 'AND', conditions: [] }].map(value => ({ value })))(
    'only explicit real preparation denial disables unsupported conditions while retaining the ordinary option %#', async ({ value }) => {
      const f = fixture(); f.state.conditions = value
      f.lockRecordExecution.mockRejectedValueOnce(new AutomationReadLedgerError('AUTOMATION_READ_DENIED'))
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, recordTriggerType: null, recordRuleRevision: null })
    },
  )
  it.each([['manual'], ['schedule'], ['manual', 'schedule']].map(allowedTriggers => ({ allowedTriggers })))(
    'requires the locked policy to allow record in addition to eligible metadata %#', async ({ allowedTriggers }) => {
      const f = fixture(); f.lockExecution.mockResolvedValue({ ...proof(), allowedTriggers })
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, recordTriggerType: null, recordRuleRevision: null })
    },
  )
  it.each(['record.created', 'record.updated'])('derives %s eligibility only after the same-transaction execution proof has settled', async triggerType => {
    const f = fixture()
    f.state.triggerType = triggerType
    let release!: () => void
    let signalProofEntered!: () => void
    const heldProof = new Promise<void>(resolve => { release = resolve })
    const proofEntered = new Promise<void>(resolve => { signalProofEntered = resolve })
    f.lockExecution.mockImplementation(async (_trx, _actor, selector) => {
      f.events.push(`proof:${selector.ruleId}`)
      signalProofEntered()
      await heldProof
      return proof()
    })
    const pending = f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    try {
      await Promise.race([proofEntered, pending.then(() => { throw new Error('Discovery skipped the execution proof') })])
      expect(f.lockExecution).toHaveBeenCalledTimes(1)
      expect(f.events.some(event => event.startsWith('name:'))).toBe(false)
      // The unlocked hint was fetched already. Only post-proof locked metadata may decide the flag.
      f.state.conditions = { conjunction: 'AND', conditions: [] }
    } finally { release() }
    const page = await pending
    expect(page.items[0].recordActivationEligible).toBe(true)
    expect(page.items[0].recordTriggerType).toBe(triggerType)
    expect(page.items[0].recordRuleRevision).toBe(ruleRevision)
    expect(page.items[0].recordCondition).toMatchObject({ mode: 'saved_conditions' })
    expect(f.events).toEqual(['fence', 'candidates', 'proof:synthetic-rule-1', 'name:synthetic-rule-1', 'fence'])
    expect(f.lockExecution.mock.calls[0][0]).toMatchObject({ query: f.query })
  })
  it.each(['record.created', 'record.updated'])('returns only the post-proof current %s and its matching revision', async triggerType => {
    const f = fixture()
    f.state.triggerType = triggerType === 'record.created' ? 'record.updated' : 'record.created'
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const proofEntered = new Promise<void>(resolve => { entered = resolve })
    f.lockExecution.mockImplementation(async (_trx, _owner, selector) => {
      f.events.push(`proof:${selector.ruleId}`); entered(); await held
      return proof()
    })
    const pending = f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    try {
      await Promise.race([proofEntered, pending.then(() => { throw new Error('Discovery skipped the execution proof') })])
      expect(f.events.some(event => event.startsWith('name:'))).toBe(false)
      f.state.triggerType = triggerType; f.state.ruleRevision = nextRuleRevision; f.state.name = 'Current locked preview'
    } finally { release() }
    const page = await pending
    expect(page.items[0]).toMatchObject({ ruleName: 'Current locked preview', recordActivationEligible: true,
      scheduleActivationEligible: false, recordTriggerType: triggerType, recordRuleRevision: nextRuleRevision })
    expect(f.events).toEqual(['fence', 'candidates', 'proof:synthetic-rule-1', 'name:synthetic-rule-1', 'fence'])
    expect(f.lockExecution.mock.calls[0][0]).toMatchObject({ query: f.query })
    expect(f.sql.find(call => call.statement.startsWith('SELECT name,'))?.statement)
      .toContain('integration_authority_revision::text AS rule_revision')
  })
  it.each([undefined, null, '', 'not-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 1, {}, []].map(value => ({ value })))(
    'refuses eligible record metadata with a malformed or missing locked revision %#', async ({ value }) => {
      const f = fixture(); f.state.ruleRevision = value
      await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(f.lockExecution).toHaveBeenCalledTimes(1)
      expect(f.events).toEqual(['fence', 'candidates', 'proof:synthetic-rule-1', 'name:synthetic-rule-1'])
    },
  )
  for (const allowManual of [false, true]) {
    it.each([
      { expression: '0 9 * * *' }, { cron: '*/5 * * * *', timezone: 'UTC' },
      { expression: '30 1 * * *', timezone: 'America/New_York' },
      Object.assign(Object.create(null) as Record<string, unknown>, { cron: '0 0 1 1 *' }),
    ])(`derives schedule eligibility from a closed saved cron independently of manual opt-in (${allowManual}): %#`, async triggerConfig => {
      const f = scheduleFixture(), allowedTriggers = allowManual ? ['manual', 'schedule'] : ['schedule']
      f.state.triggerConfig = triggerConfig
      f.lockExecution.mockResolvedValue({ ...proof(), allowedTriggers })
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page).toEqual({ items: [{ selector: hint(), ruleName: 'Synthetic preview', budget, allowedTriggers,
        recordActivationEligible: false, scheduleActivationEligible: true, recordTriggerType: null, recordRuleRevision: null, recordCondition: null,
        scheduleRuleRevision: ruleRevision, scheduleDefinition: { triggerType: 'schedule.cron', config: triggerConfig } }], nextCursor: null })
      expect(Object.keys(page.items[0]).sort()).toEqual(['allowedTriggers', 'budget', 'recordActivationEligible', 'recordCondition',
        'recordRuleRevision', 'recordTriggerType', 'ruleName', 'scheduleActivationEligible', 'scheduleDefinition', 'scheduleRuleRevision', 'selector'])
      expect(page.items[0]).not.toHaveProperty('triggerConfig')
      expect(page.items[0]).not.toHaveProperty('cronConfig')
      expect(f.authority.lockObservation).not.toHaveBeenCalled()
    })
  }
  it.each(['schedule.interval', 'schedule.date_field', 'record.created', 'record.updated', 'SCHEDULE.CRON'])(
    'does not infer cron eligibility from matching config or schedule allowance for %s', async triggerType => {
      const f = scheduleFixture(); f.state.triggerType = triggerType
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, scheduleActivationEligible: false })
    },
  )
  it.each([undefined, {}, [], false, '', 'null', { conjunction: 'AND', conditions: [] }].map(value => ({ value })))(
    'cron eligibility requires actual PG null conditions, not a missing/string/empty value %#', async ({ value }) => {
      const f = scheduleFixture(); f.state.conditions = value
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, scheduleActivationEligible: false })
    },
  )
  it.each([['manual'], ['record'], ['manual', 'record']].map(allowedTriggers => ({ allowedTriggers })))(
    'cron eligibility also requires schedule in the actual locked policy %#', async ({ allowedTriggers }) => {
      const f = scheduleFixture(); f.lockExecution.mockResolvedValue({ ...proof(), allowedTriggers })
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0]).toMatchObject({ recordActivationEligible: false, scheduleActivationEligible: false })
    },
  )
  it.each([
    null, undefined, {}, [], false, 'null', '{"expression":"* * * * *"}',
    { expression: '' }, { expression: 'invalid' }, { expression: '0 0 30 2 *' },
    { expression: '0 9 * * *', cron: '0 9 * * *' }, { expression: '0 9 * * *', timezone: 'Not/AZone' },
    { expression: '0 9 * * *', timezone: ' UTC ' }, { expression: '0 9 * * *', timezone: null },
    { expression: '0 9 * * *', timezone: 1 }, { expression: '0 9 * * *', projectNo: 'synthetic-project' },
    Object.create({ expression: '0 9 * * *' }) as Record<string, unknown>,
  ].map(triggerConfig => ({ triggerConfig })))(
    'malformed saved cron only disables schedule eligibility without removing the authorized option %#', async ({ triggerConfig }) => {
      const f = scheduleFixture(); f.state.triggerConfig = triggerConfig
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ selector: hint(), recordActivationEligible: false, scheduleActivationEligible: false })
      expect(f.events).toEqual(['fence', 'candidates', 'name:synthetic-rule-1', 'fence'])
      expect(f.lockExecution).toHaveBeenCalledTimes(1)
    },
  )
  it('rejects hooked/non-data cron config without calling getters or returning its contents', async () => {
    const getter = vi.fn(() => '* * * * *')
    for (const config of [Object.defineProperty({}, 'expression', { enumerable: true, get: getter }),
      Object.defineProperty({ expression: '* * * * *' }, 'timezone', { enumerable: true, get: getter }),
      Object.defineProperty({}, 'expression', { enumerable: false, value: '* * * * *' }),
      { expression: '* * * * *', [Symbol('synthetic-private')]: 'synthetic-private' },
      new Proxy({}, { ownKeys() { throw new Error('synthetic-private') } })]) {
      const f = scheduleFixture(); f.state.triggerConfig = config
      const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
      expect(page.items[0].scheduleActivationEligible).toBe(false)
      expect(JSON.stringify(page)).not.toContain('synthetic-private')
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([
    { triggerType: 'record.created', config: {}, record: true, schedule: false },
    { triggerType: 'record.updated', config: {}, record: true, schedule: false },
    { triggerType: 'schedule.cron', config: cronConfig(), record: false, schedule: true },
  ])('record and schedule eligibility remain mutually exclusive even with both allowed families: $triggerType', async data => {
    const f = fixture(); f.state.triggerType = data.triggerType; f.state.triggerConfig = data.config
    f.lockExecution.mockResolvedValue({ ...proof(), allowedTriggers: ['record', 'schedule'] })
    const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    expect(page.items[0]).toMatchObject({ recordActivationEligible: data.record, scheduleActivationEligible: data.schedule,
      recordTriggerType: data.record ? data.triggerType : null, recordRuleRevision: data.record ? ruleRevision : null })
  })
  it.each([true, false])('schedule eligibility uses only post-proof current metadata, even when the earlier state differs: %s', async eligible => {
    const f = scheduleFixture()
    // Make the pre-proof state the opposite of the state exposed under the lock.
    f.state.conditions = eligible ? {} : null
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const proofEntered = new Promise<void>(resolve => { entered = resolve })
    f.lockExecution.mockImplementation(async (_trx, _owner, selector) => {
      f.events.push(`proof:${selector.ruleId}`); entered(); await held
      return { ...proof(), allowedTriggers: ['schedule'] }
    })
    const pending = f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    try {
      await Promise.race([proofEntered, pending.then(() => { throw new Error('Discovery skipped the execution proof') })])
      expect(f.events.some(event => event.startsWith('name:'))).toBe(false)
      f.state.conditions = eligible ? null : {}
    } finally { release() }
    const page = await pending
    expect(page.items[0]).toMatchObject({ recordActivationEligible: false, scheduleActivationEligible: eligible })
    expect(f.events).toEqual(['fence', 'candidates', 'proof:synthetic-rule-1', 'name:synthetic-rule-1', 'fence'])
  })
  it('invalid cron on cursor/lookahead is display-only and cannot lose page items or change the authorized cursor', async () => {
    const f = scheduleFixture(); f.state.rows = [hint('synthetic-rule-1'), hint('synthetic-rule-2')]
    f.state.metadataByRule.set('synthetic-cursor', { trigger_config: { expression: 'invalid' } })
    f.state.metadataByRule.set('synthetic-rule-2', { trigger_config: { expression: '* * * * *', timezone: 'Not/AZone' } })
    const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet', limit: 1, after: 'synthetic-cursor' })
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBe('synthetic-rule-1')
    expect(page.items[0]).toMatchObject({ selector: hint('synthetic-rule-1'), recordActivationEligible: false, scheduleActivationEligible: true })
    expect(f.lockExecution.mock.calls.map(call => call[2].ruleId)).toEqual(['synthetic-cursor', 'synthetic-rule-1', 'synthetic-rule-2'])
    expect(f.events).toEqual(['fence', 'cursor', 'name:synthetic-cursor', 'candidates', 'name:synthetic-rule-1', 'name:synthetic-rule-2', 'fence'])
  })
  it.each([1000, 1001, 60000, 2147483647])('describes a locked interval %sms with its persisted phase and revision', async intervalMs => {
    const f = scheduleFixture(), anchorMs = Date.parse('2026-10-01T00:00:00.123Z')
    f.state.triggerType = 'schedule.interval'; f.state.triggerConfig = { intervalMs }; f.state.intervalAnchorMs = String(anchorMs)
    const page = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    expect(page.items[0]).toMatchObject({ recordActivationEligible: false, scheduleActivationEligible: true,
      scheduleRuleRevision: ruleRevision, scheduleDefinition: { triggerType: 'schedule.interval', intervalMs, anchorMs } })
    expect(f.events.indexOf('name:synthetic-rule-1')).toBeGreaterThan(f.events.indexOf('candidates'))
  })
  it.each([null, undefined, '', '1.5', 'Infinity', '0', '-1', '8640000000000001'])(
    'does not invent an interval phase from invalid DB metadata %#', async anchor => {
      const f = scheduleFixture(); f.state.triggerType = 'schedule.interval'; f.state.triggerConfig = { intervalMs: 1000 }; f.state.intervalAnchorMs = anchor
      expect((await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).items[0]).toMatchObject({
        scheduleActivationEligible: false, scheduleRuleRevision: null, scheduleDefinition: null,
      })
    },
  )
  it.each(['proof', 'locked-query'] as const)('a saved cron parse problem never hides an actual %s failure', async failed => {
    const f = scheduleFixture(); f.state.triggerConfig = { expression: 'invalid' }
    if (failed === 'proof') f.lockExecution.mockRejectedValueOnce(new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED'))
    else {
      const actual = f.query.getMockImplementation()!
      f.query.mockImplementation(async (statement, params) => {
        if (statement.startsWith('SELECT name,')) throw new Error('synthetic-private-sql')
        return actual(statement, params)
      })
    }
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({
      code: failed === 'proof' ? 'AUTOMATION_READ_SCOPE_CHANGED' : 'AUTOMATION_READ_UNAVAILABLE',
    })
    expect(f.lockExecution).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event === 'fence')).toHaveLength(1)
  })
  it('retains pointer precedence, real sheet/base and owner filters without requiring config.dataSourceId', async () => {
    const f = fixture(); await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    const sql = f.sql.find(call => call.statement.includes('SELECT r.id AS'))!.statement
    for (const fragment of ['base.id=s.base_id', 'r.sheet_id=$5 AND r.created_by=$1', 'p.tenant_id=b.tenant_id',
      "d.tenant_id=$2 AND d.owner_id=$1", 'CASE WHEN pointer.id IS NULL', 'ELSE pointer.external_system_id END',
      'p.producer_generation=$3::bigint', 'm.connection_incarnation=d.connection_incarnation', 'COLLATE "C"']) expect(sql).toContain(fragment)
    expect(sql).not.toContain('dataSourceId'); expect(sql).not.toContain('r.name')
  })
  it.each(['admin', 'membership'] as const)('empty lists still reject missing live %s authority', async key => {
    const f = fixture(); f.state.rows = []; f.state[key] = false
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
    expect(f.lockExecution).not.toHaveBeenCalled(); expect(f.events).toEqual([])
  })
  it.each(['live', 'afterLive'] as const)('empty lists check producer %s', async key => {
    const f = fixture(); f.state.rows = []; f.state[key] = false
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
  })
  it('empty valid lists contain no total and still take both fences', async () => {
    const f = fixture(); f.state.rows = []
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).resolves.toEqual({ items: [], nextCursor: null })
    expect(f.events).toEqual(['fence', 'candidates', 'fence'])
  })
  it('uses the shared bounded SHARE reader for both fences and restores before discovery queries', async () => {
    const f = fixture(); f.state.rows = []
    await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    const slots = f.sql.filter(call => call.statement.includes('FROM automation_read_producer_slot'))
    expect(slots.filter(call => call.statement.includes('FOR SHARE'))).toHaveLength(2)
    expect(slots.every(call => !call.statement.includes('NOWAIT') && !call.statement.includes('KEY SHARE'))).toBe(true)
    expect(slots.filter(call => call.statement.includes('expires_at > pg_catalog.clock_timestamp()'))).toHaveLength(2)
    expect(f.sql.filter(call => call.statement.includes("set_config('lock_timeout'")).map(call => call.params))
      .toEqual([['250ms'], ['0'], ['250ms'], ['0']])
    const firstRestore = f.sql.findIndex(call => call.params?.[0] === '0')
    const candidates = f.sql.findIndex(call => call.statement.includes('SELECT r.id AS'))
    expect(firstRestore).toBeGreaterThan(0); expect(candidates).toBeGreaterThan(firstRestore)
  })
  it('rejects expiry after a delayed slot acquisition before candidate lookup', async () => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    let entered!: () => void, release!: () => void
    const enteredLock = new Promise<void>(resolve => { entered = resolve })
    const delayedLock = new Promise<void>(resolve => { release = resolve })
    f.query.mockImplementation(async (statement, params) => {
      if (statement.includes('FROM automation_read_producer_slot') && statement.includes('FOR SHARE')) {
        entered(); await delayedLock
      }
      return actual(statement, params)
    })
    const run = f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    const refusal = expect(run).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    await enteredLock
    f.state.live = false; release(); await refusal
    expect(f.events).toEqual(['fence'])
    expect(f.lockExecution).not.toHaveBeenCalled()
  })
  it('does not replace a slot timeout with a restore error or retry/name disclosure', async () => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    let acquisitions = 0
    f.query.mockImplementation(async (statement, params) => {
      if (statement.includes('FROM automation_read_producer_slot') && statement.includes('FOR SHARE')) {
        acquisitions++; throw { code: '55P03', message: 'private slot failure' }
      }
      if (statement.includes("set_config('lock_timeout'") && params?.[0] === '0') throw new Error('Must not restore aborted transaction')
      return actual(statement, params)
    })
    const error = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' }).catch(error => error)
    expect(error).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(String(error)).not.toContain('private')
    expect(acquisitions).toBe(1)
    expect(f.sql.filter(call => call.statement.includes("set_config('lock_timeout'")).map(call => call.params)).toEqual([['250ms']])
    expect(f.events).toEqual([])
    expect(f.lockExecution).not.toHaveBeenCalled()
  })
  it('rejects a replaced producer before candidate lookup', async () => {
    const f = fixture(); f.state.generation = '2'
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    // The locked identity already differs: do not adopt a later fresh receipt.
    expect(f.events).toEqual([])
    expect(f.sql.filter(call => call.statement.includes('FOR SHARE') && call.statement.includes('FROM automation_read_producer_slot'))).toHaveLength(1)
    expect(f.sql.some(call => call.statement.includes('expires_at > pg_catalog.clock_timestamp()'))).toBe(false)
  })
  it('rejects nontransaction isolation before any discovery lookup', async () => {
    const f = fixture(); f.state.isolation = 'repeatable read'
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED' })
    expect(f.events).toEqual([])
  })
  it.each([0, 1, 2])('refuses the whole page on proof failure at position %s, including cursor/lookahead', async failed => {
    const f = fixture(); f.state.rows = [hint('synthetic-rule-1'), hint('synthetic-rule-2')]
    let index = 0
    f.lockExecution.mockImplementation(async (_trx, _owner, selector) => {
      if (index++ === failed) throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
      f.events.push(`proof:${selector.ruleId}`); return proof()
    })
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet', limit: 1, after: 'synthetic-cursor' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect(f.lockExecution).toHaveBeenCalledTimes(failed + 1)
    expect(f.events.filter(event => event.startsWith('name:'))).toHaveLength(failed)
  })
  it('denies a missing/foreign cursor without page lookup or name reads', async () => {
    const f = fixture(); f.state.cursor = []
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet', after: 'foreign-rule' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(f.events).toEqual(['fence', 'cursor']); expect(f.lockExecution).not.toHaveBeenCalled()
  })
  it('rejects provider scope mismatch before reading names', async () => {
    const f = fixture(); f.lockExecution.mockResolvedValue({ ...proof(), tenantId: 'foreign-tenant' })
    await expect(f.discovery.options(actor, { sheetId: 'synthetic-sheet' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(f.events.some(event => event.startsWith('name:'))).toBe(false)
  })
  it('caps only authenticated rule names', async () => {
    const f = fixture(); f.state.name = 'x'.repeat(300)
    const result = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    expect(result.items[0].ruleName).toBe('x'.repeat(160))
  })
  it('keeps legitimate unnamed rules selectable without inventing an internal label', async () => {
    const f = fixture(); f.state.name = null
    const result = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' })
    expect(result.items[0].ruleName).toBe('')
    expect(f.lockExecution).toHaveBeenCalledTimes(1)
  })
  it('does not leak driver or provider exceptions and never retries', async () => {
    const f = fixture(); f.lockExecution.mockRejectedValue(new Error('synthetic-private-sql'))
    const error = await f.discovery.options(actor, { sheetId: 'synthetic-sheet' }).catch(error => error)
    expect(error).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE', message: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(error).not.toHaveProperty('cause'); expect(f.lockExecution).toHaveBeenCalledTimes(1)
    expect(f.events).toEqual(['fence', 'candidates'])
  })
  it.each([{}, { sheetId: '' }, { sheetId: ' padded ' }, { sheetId: 'sheet', limit: 0 }, { sheetId: 'sheet', limit: 51 },
    { sheetId: 'sheet', limit: 1.5 }, { sheetId: 'sheet', limit: '1' }, { sheetId: 'sheet', after: '' },
    { sheetId: 'sheet', targetId: 'private' }, { sheetId: 'sheet', tenantId: 'private' }])('rejects malformed options before IO: %j', async input => {
    const f = fixture()
    await expect(f.discovery.options(actor, input as never)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('captures own inputs before awaiting and never invokes getters', async () => {
    const f = fixture(), getter = vi.fn(() => 'private')
    const invalid = Object.defineProperty({}, 'sheetId', { enumerable: true, get: getter })
    await expect(f.discovery.options(actor, invalid as never)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(getter).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled()
    const input = { sheetId: 'synthetic-sheet' }, owner = { ...actor }
    const run = f.discovery.options(owner, input)
    input.sheetId = 'foreign-sheet'; owner.actorId = 'foreign-owner'
    await run
    expect(f.lockExecution.mock.calls[0][1]).toEqual(actor)
    expect(f.sql.find(call => call.statement.includes('SELECT r.id AS'))?.params?.[4]).toBe('synthetic-sheet')
  })
})
