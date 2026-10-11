/** Composition/identity evidence only. Metadata ports are explicit doubles here;
 * current permissions, locks and committed snapshots require the real-PG suite. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LockedAutomationReadRule } from '../../../src/integration/automation-read-rule-authority'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

const doubles = vi.hoisted(() => ({ profile: vi.fn(), target: vi.fn(), material: vi.fn(), rule: vi.fn(),
  conditionLock: vi.fn(), evaluate: vi.fn(), conditionFactory: vi.fn(), zone: 'UTC' }))
vi.mock('../../../src/integration/automation-live-authority', () => ({ assertAutomationIntegrationActor: async () => {} }))
vi.mock('../../../src/multitable/pg-transaction-guard', () => ({ assertInTransaction: async () => {} }))
vi.mock('../../../src/integration/automation-read-profiles', () => ({ lockAutomationReadProfile: doubles.profile }))
vi.mock('../../../src/integration/automation-read-source-observation', () => ({ lockAutomationReadSourceObservation: async () => {} }))
vi.mock('../../../src/integration/automation-read-source-pointer', () => ({ lockAutomationReadSourcePointer: async () => ({ state: 'unbound' }) }))
vi.mock('../../../src/integration/automation-read-target-context', () => ({
  createAutomationReadTargetContext: () => ({ lock: doubles.target, materialFor: doubles.material }),
}))
vi.mock('../../../src/integration/automation-read-rule-authority', () => ({ lockAutomationReadRule: doubles.rule }))
vi.mock('../../../src/multitable/business-timezone', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/multitable/business-timezone')>(),
  resolveMultitableBusinessTimezone: () => doubles.zone,
}))
vi.mock('../../../src/integration/automation-read-record-conditions', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/integration/automation-read-record-conditions')>(),
  createAutomationReadRecordConditions: (input: unknown) => {
    doubles.conditionFactory(input)
    return { lock: doubles.conditionLock, evaluate: doubles.evaluate }
  },
}))

import { createAutomationReadAuthority, type AutomationReadAuthorityOptions } from '../../../src/integration/automation-read-authority'
import { AutomationReadRecordConditionsError } from '../../../src/integration/automation-read-record-conditions'

const nonce = '11111111-1111-4111-8111-111111111111'
const schema = '22222222-2222-4222-8222-222222222222'
const actor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-source', targetId: nonce }
const budget = { maxRows: 10, maxPages: 2, maxReadCount: 4, timeoutMs: 1000 }
const event = { outboxId: 'synthetic-outbox', eventId: 'synthetic-event', eventType: 'multitable.record.created' as const }
const context = Object.freeze({ scope: { actorId: actor.actorId, ruleId: selector.ruleId, sheetId: 'sheet', baseId: 'base' },
  ruleRevision: nonce, schemaRevision: schema, fieldIds: ['person'], fingerprint: 'a'.repeat(64) })
const publicKeys = ['actorId', 'tenantId', 'workspaceId', 'key', 'budget', 'sourceReference', 'allowedTriggers'].sort()
let rule: LockedAutomationReadRule
let trx: Queryable
function options(): AutomationReadAuthorityOptions {
  return { producer: { generation: '1', nonce }, budgetCeiling: budget,
    codec: { restoreStockPreparationAutomationProfileMaterial: () => { throw new Error('unused composition double') },
      deriveAutomationReadTargetContract: () => { throw new Error('unused composition double') },
      composeStockPreparationAutomationExecution: () => ({ action: { fixed: true }, budget }) },
    sourceStore: { async lockActiveForAutomation() { return { activation: {}, version: {},
      sourceValidation: { connectionId: 'synthetic-connection', connectionRevision: nonce, bindingRevision: nonce },
      sourceAuthority: { versionRevision: nonce, receiptRevision: nonce, activationRevision: nonce, receipt: {} } } } } }
}
beforeEach(() => {
  vi.clearAllMocks()
  doubles.zone = 'UTC'
  rule = { ruleId: selector.ruleId, sheetId: 'sheet', baseId: 'base', createdBy: actor.actorId,
    authorityRevision: nonce, fingerprint: 'b'.repeat(64), triggerType: 'record.created', triggerConfig: null,
    actionType: 'integration_read_preview', actionConfig: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false },
    conditions: null, actions: null, executionMode: null }
  doubles.rule.mockImplementation(async () => Object.freeze({ ...rule }))
  doubles.profile.mockResolvedValue({ actionId: selector.actionId, revision: nonce })
  doubles.target.mockResolvedValue({ scope: { actionId: selector.actionId, sheetId: 'sheet', baseId: 'base' },
    revisions: { profileRevision: nonce, sheetRevision: schema }, targetContract: { executionKey: 'synthetic-target-key',
      action: { source: { kind: 'data-source:sql-readonly', externalSystemId: selector.systemId } } } })
  doubles.material.mockReturnValue({ installedFieldProperties: {}, extFieldMapping: {} })
  doubles.conditionLock.mockResolvedValue(context)
  doubles.evaluate.mockResolvedValue(Object.freeze({ kind: 'match' }))
  trx = { async query(statement: string) {
    if (statement.includes('transaction_isolation')) return { rows: [{ isolation: 'read committed' }], rowCount: 1 }
    if (statement.includes('connection_incarnation')) return { rows: [{ connection_incarnation: nonce }], rowCount: 1 }
    throw new Error('Unexpected composition-fixture SQL')
  } }
})

describe('Record authority composition preserves private proof identity', () => {
  it.each(['record.created', 'record.updated'])('NULL %s keeps the ordinary key and registers only the record proof', async triggerType => {
    rule = { ...rule, triggerType }
    const authority = createAutomationReadAuthority(options())
    const ordinary = await authority.lockExecution(trx, actor, selector)
    const record = await authority.lockRecordExecution(trx, actor, selector)
    expect(record.key).toBe(ordinary.key)
    expect(record).toEqual(ordinary)
    expect(Object.keys(record).sort()).toEqual(publicKeys)
    expect(authority.recordConditionFor(record)).toEqual({ mode: 'unconditional' })
    expect(Object.isFrozen(authority.recordConditionFor(record))).toBe(true)
    expect(() => authority.recordConditionFor(ordinary)).toThrow('AUTOMATION_READ_DENIED')
    expect(await authority.evaluateRecordConditions(trx, ordinary, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    expect(await authority.evaluateRecordConditions(trx, record, event)).toEqual({ kind: 'match' })
    expect(doubles.conditionLock).not.toHaveBeenCalled()
    expect(doubles.evaluate).not.toHaveBeenCalled()
    expect(authority.materialFor(record)).toBeDefined()
  })
  it('saved conditions retain the original context and factory-fixed timezone without expanding public proof keys', async () => {
    rule = { ...rule, conditions: { logic: 'and', conditions: [{ fieldId: 'person', operator: 'contains', value: 'synthetic-user' }] } }
    const authority = createAutomationReadAuthority(options())
    doubles.zone = 'Asia/Singapore'
    const ordinary = await authority.lockExecution(trx, actor, selector)
    const proof = await authority.lockRecordExecution(trx, actor, selector)
    expect(proof.key).not.toBe(ordinary.key)
    expect(Object.keys(proof).sort()).toEqual(publicKeys)
    const descriptor = authority.recordConditionFor(proof)
    expect(descriptor).toEqual({ mode: 'saved_conditions', schemaRevision: schema, businessTimeZone: 'UTC' })
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(doubles.conditionFactory).toHaveBeenCalledWith({ businessTimeZone: 'UTC' })
    expect(await authority.evaluateRecordConditions(trx, proof, event)).toEqual({ kind: 'match' })
    expect(doubles.evaluate).toHaveBeenCalledWith(trx, context, event)
    expect(authority.materialFor(proof)).toBeDefined()
  })
  it.each([false, true])('clones and another authority cannot adopt genuine record proof, conditional=%s', async conditional => {
    if (conditional) rule = { ...rule, conditions: { logic: 'and', conditions: [{ fieldId: 'person', operator: 'is_not_empty' }] } }
    const authority = createAutomationReadAuthority(options()), other = createAutomationReadAuthority(options())
    const proof = await authority.lockRecordExecution(trx, actor, selector)
    for (const [port, candidate] of [[authority, { ...proof }], [other, proof]] as const) {
      expect(() => port.recordConditionFor(candidate)).toThrow('AUTOMATION_READ_DENIED')
      expect(await port.evaluateRecordConditions(trx, candidate, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    }
    expect(doubles.evaluate).not.toHaveBeenCalled()
  })
  it.each(['record.deleted', 'field.value_changed', 'schedule.cron'])('does not turn unsupported %s into unconditional record authority', async triggerType => {
    rule = { ...rule, triggerType }
    await expect(createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, selector))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(doubles.conditionLock).not.toHaveBeenCalled()
  })
  it('rejects nonempty trigger configuration even when conditions are NULL', async () => {
    rule = { ...rule, triggerConfig: { fieldId: 'person' } }
    await expect(createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, selector))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
  })
  it.each(['AUTOMATION_READ_RECORD_CONDITIONS_DENIED', 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE'] as const)(
    'maps preparation %s without a fallback or private cause', async code => {
      rule = { ...rule, conditions: { logic: 'and', conditions: [{ fieldId: 'person', operator: 'is_not_empty' }] } }
      doubles.conditionLock.mockRejectedValue(new AutomationReadRecordConditionsError(code))
      const result = await createAutomationReadAuthority(options()).lockRecordExecution(trx, actor, selector).catch(error => error)
      expect(result).toMatchObject({ code: code.endsWith('_DENIED') ? 'AUTOMATION_READ_DENIED' : 'AUTOMATION_READ_UNAVAILABLE' })
      expect(result).not.toHaveProperty('cause')
      expect(doubles.evaluate).not.toHaveBeenCalled()
    },
  )
})
