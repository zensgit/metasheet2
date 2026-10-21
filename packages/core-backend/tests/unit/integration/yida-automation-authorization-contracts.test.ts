import { describe, expect, it } from 'vitest'
import { checkedYidaAutomationAuthorization, checkedYidaAutomationRequest,
  captureYidaAutomationOccurrence } from '../../../src/integration/yida-automation-authorization-contracts'

const revision = '11111111-1111-4111-8111-111111111111'
const grant = '22222222-2222-4222-8222-222222222222'
const activation = '33333333-3333-4333-8333-333333333333'
const draft = () => ({ confirmationId: 'confirmation', ruleId: 'rule', expectedRuleRevision: revision,
  actionId: 'slot', projectNo: 'synthetic-project', operationId: 'operation', rowKeys: ['row-a', 'row-b'],
  allowedTriggers: ['schedule.interval', 'manual'], maxExecutions: 2, ttlMs: 900000 })
const manual = () => ({ grantId: grant, activationId: activation, ruleId: 'rule', ruleRevision: revision,
  actionId: 'slot', triggerType: 'manual', requestKey: 'request' })
const interval = () => ({ ...manual(), triggerType: 'schedule.interval', requestKey: undefined,
  scheduledAtMs: 120000, anchorMs: 60000, intervalMs: 60000, scheduleDefinitionDigest: 'a'.repeat(64) })
function scheduled() {
  const { requestKey: _requestKey, ...result } = interval()
  return result
}
function denied(run: () => unknown) { expect(run).toThrow('YIDA_AUTOMATION_INPUT_INVALID') }

describe('SA06D consent descriptions — not execution authority', () => {
  it('captures immutable finite consent and does not mutate or freeze caller data', () => {
    const input = draft(), result = checkedYidaAutomationAuthorization(input)
    expect(result.maxTotalRows).toBe(2)
    expect(result.allowedTriggers).toEqual(['manual', 'schedule.interval'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.rowKeys)).toBe(true)
    expect(Object.isFrozen(result.allowedTriggers)).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
    input.rowKeys[0] = 'changed'
    input.allowedTriggers[0] = 'webhook.received'
    expect(result.rowKeys).toEqual(['row-a', 'row-b'])
    expect(result.allowedTriggers).toEqual(['manual', 'schedule.interval'])
  })
  it.each([1, 10])('accepts the explicit execution boundary %s', maxExecutions => {
    const input = { ...draft(), rowKeys: ['row'], maxExecutions }
    expect(checkedYidaAutomationAuthorization(input).maxExecutions).toBe(maxExecutions)
  })
  it.each([1, 900000])('accepts the explicit TTL boundary %s', ttlMs => {
    expect(checkedYidaAutomationAuthorization({ ...draft(), ttlMs }).ttlMs).toBe(ttlMs)
  })
  it.each([0, -1, 11, 1.5, NaN, Infinity, '2', null, true])('rejects an invalid execution budget %#', maxExecutions => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), maxExecutions }))
  })
  it.each([0, -1, 900001, 1.5, NaN, Infinity, '900000', null])('rejects an invalid TTL %#', ttlMs => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), ttlMs }))
  })
  it.each(['tenantId', 'ownerId', 'actorId', 'workspaceId', 'payload', 'digest', 'fetch', 'maxTotalRows'])('rejects caller authority field %s', key => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), [key]: 'untrusted' }))
  })
  it.each(Object.keys(draft()))('does not infer omitted consent field %s', key => {
    const input: Record<string, unknown> = draft()
    delete input[key]
    denied(() => checkedYidaAutomationAuthorization(input))
  })
  it.each([[], ['row', 'row'], ['row', ' '], Array.from({ length: 11 }, (_, n) => String(n)),
    Array(2), { 0: 'row', length: 1 }])('rejects nonfinite or malformed selections %#', rowKeys => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), rowKeys, maxExecutions: 10 }))
  })
  it('rejects a row selection beyond its explicit execution budget', () => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), maxExecutions: 1 }))
  })
  it.each([[], ['manual', 'manual'], ['schedule.cron'], ['record.created'], ['webhook.received'],
    ['manual', 'schedule.interval', 'manual']])('refuses unapproved trigger kinds %#', allowedTriggers => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), allowedTriggers }))
  })
  it('rejects accessors, symbol fields and Proxies without invoking caller traps', () => {
    let calls = 0
    const input = draft()
    Object.defineProperty(input, 'projectNo', { get() { calls++; return 'unsafe' }, enumerable: true })
    denied(() => checkedYidaAutomationAuthorization(input))
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), [Symbol('owner')]: true }))
    denied(() => checkedYidaAutomationAuthorization(new Proxy(draft(), { ownKeys() { calls++; throw Error('private') } })))
    const rows = ['row']
    Object.defineProperty(rows, '0', { get() { calls++; return 'unsafe' }, enumerable: true })
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), rowKeys: rows }))
    expect(calls).toBe(0)
  })
  it('accepts null-prototype own data but rejects inherited consent', () => {
    expect(checkedYidaAutomationAuthorization(Object.assign(Object.create(null), draft())).maxTotalRows).toBe(2)
    denied(() => checkedYidaAutomationAuthorization(Object.create(draft())))
  })
  it.each(['', ' ', 'x\n', 'x'.repeat(129)])('refuses malformed identity %#', projectNo => {
    denied(() => checkedYidaAutomationAuthorization({ ...draft(), projectNo }))
  })
  it('does not let the request endpoint carry a scope, row or permission', () => {
    expect(checkedYidaAutomationRequest({ requestKey: 'r' })).toEqual({ requestKey: 'r' })
    for (const key of ['rowKey', 'actorId', 'tenantId', 'permit']) {
      denied(() => checkedYidaAutomationRequest({ requestKey: 'r', [key]: 'unsafe' }))
    }
  })
})

describe('SA06D stable occurrence descriptions — not scheduler proofs', () => {
  it('uses deterministic explicit tuples, independent of object insertion order', () => {
    const expected = captureYidaAutomationOccurrence(manual())
    const reordered = Object.fromEntries(Object.entries(manual()).reverse())
    expect(captureYidaAutomationOccurrence(reordered)).toEqual(expected)
    expect(expected.occurrenceKey).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(expected)).toBe(true)
  })
  it.each(['grantId', 'activationId', 'ruleId', 'ruleRevision', 'actionId', 'requestKey'])('binds manual identity to %s', key => {
    const base = manual()
    const replacement = ['grantId', 'activationId', 'ruleRevision'].includes(key)
      ? '44444444-4444-4444-8444-444444444444' : 'different'
    expect(captureYidaAutomationOccurrence({ ...base, [key]: replacement }).occurrenceKey)
      .not.toBe(captureYidaAutomationOccurrence(base).occurrenceKey)
  })
  it('binds actual interval definition and scheduled occurrence, not dispatch time', () => {
    const base = scheduled(), key = captureYidaAutomationOccurrence(base).occurrenceKey
    expect(captureYidaAutomationOccurrence({ ...base }).occurrenceKey).toBe(key)
    expect(captureYidaAutomationOccurrence({ ...base, scheduledAtMs: 180000 }).occurrenceKey).not.toBe(key)
    expect(captureYidaAutomationOccurrence({ ...base, scheduleDefinitionDigest: 'b'.repeat(64) }).occurrenceKey).not.toBe(key)
  })
  it.each(['attempts', 'fence', 'now', 'ownerId', 'permit'])('rejects request-controlled runtime field %s', key => {
    denied(() => captureYidaAutomationOccurrence({ ...manual(), [key]: 'unsafe' }))
  })
  it.each([0, -1, 120001, NaN, Infinity, '120000', 8640000000000001])('rejects invalid interval occurrence %#', scheduledAtMs => {
    denied(() => captureYidaAutomationOccurrence({ ...scheduled(), scheduledAtMs }))
  })
  it('rejects the wrong branch, missing or malformed revision and fake producer digest', () => {
    denied(() => captureYidaAutomationOccurrence(interval()))
    denied(() => captureYidaAutomationOccurrence({ ...manual(), ruleRevision: 'unversioned' }))
    denied(() => captureYidaAutomationOccurrence({ ...scheduled(), scheduleDefinitionDigest: 'fake' }))
    denied(() => captureYidaAutomationOccurrence({ ...manual(), triggerType: 'webhook.received' }))
  })
  it('never invokes an occurrence getter or Proxy', () => {
    let calls = 0
    const input = manual()
    Object.defineProperty(input, 'triggerType', { get() { calls++; return 'manual' }, enumerable: true })
    denied(() => captureYidaAutomationOccurrence(input))
    denied(() => captureYidaAutomationOccurrence(new Proxy(manual(), { getPrototypeOf() { calls++; throw Error('private') } })))
    expect(calls).toBe(0)
  })
})
