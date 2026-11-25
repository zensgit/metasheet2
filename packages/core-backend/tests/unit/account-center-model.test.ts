import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mapAccountCenterFacts, type AccountCenterFacts, type AccountCenterRecordFact } from '../../src/account-center/read-model'
import type { AccountCenterResponse } from '../../../../apps/web/src/account/accountCenterContract'

let assertions = 0
beforeEach(() => expect.hasAssertions())
afterEach(() => { assertions += expect.getState().assertionCalls })
afterAll(() => console.info('account-center-model assertions', assertions))

function record(overrides: Partial<AccountCenterRecordFact> = {}): AccountCenterRecordFact {
  return {
    kind: 'record', provider: 'dingtalk', source: 'strict', label: 'Example connection',
    binding: 'bound', directoryManaged: false, boundAt: '2026-01-02T03:04:05.000Z',
    activeGrants: [], hasRevokedHistory: false, grantMode: 'records', ...overrides,
  }
}
function map(...items: AccountCenterFacts['items']): AccountCenterResponse {
  return mapAccountCenterFacts({ context: 'selected', items })
}
function unchecked(value: unknown) {
  return mapAccountCenterFacts(value as AccountCenterFacts)
}

describe('account center model', () => {
  it('keeps a successful empty collection and context', () => {
    expect(map()).toEqual({ ok: true, data: { version: 2, context: 'selected', cards: [] } })
    expect(mapAccountCenterFacts({ context: 'selection_required', items: [] }).data.context).toBe('selection_required')
  })
  it.each([
    [{ activeGrants: [{ enabled: true }], hasRevokedHistory: true }, 'enabled'],
    [{ activeGrants: [{ enabled: false }], hasRevokedHistory: true }, 'disabled'],
    [{ hasRevokedHistory: true }, 'revoked'],
    [{}, 'absent'],
    [{ source: 'legacy', grantMode: 'legacy_default' }, 'legacy_default'],
    [{ source: 'legacy', grantMode: 'legacy_default', activeGrants: [{ enabled: false }] }, 'disabled'],
    [{ source: 'legacy', grantMode: 'legacy_default', hasRevokedHistory: true }, 'revoked'],
    [{ binding: 'not_bound', boundAt: null }, 'absent'],
    [{ binding: 'not_bound', boundAt: null, activeGrants: [{ enabled: true }] }, 'absent'],
    [{ binding: 'not_bound', boundAt: null, hasRevokedHistory: true }, 'absent'],
  ] as [Partial<AccountCenterRecordFact>, string][])('projects grant case %j', (fact, grant) => {
    expect(map(record(fact)).data.cards[0]).toMatchObject({ kind: 'record', grant })
  })
  it('represents multiple active facts as a notice', () => {
    expect(map(record({ activeGrants: [{ enabled: false }, { enabled: true }] })).data.cards)
      .toEqual([{ kind: 'notice', key: 'card-1', reason: 'state_unreadable' }])
  })
  it('keeps supplied partitions even with matching labels', () => {
    expect(() => map(record(), record())).not.toThrow()
    const cards = map(record({ source: 'legacy' }), record({ activeGrants: [{ enabled: true }] }), record({ activeGrants: [{ enabled: false }] })).data.cards
    expect(cards.map(card => card.kind === 'record' && [card.source, card.grant])).toEqual([
      ['legacy', 'absent'], ['strict', 'enabled'], ['strict', 'disabled'],
    ])
    expect(cards.map(card => card.key)).toEqual(['card-1', 'card-2', 'card-3'])
  })
  it('projects closed output keys and response-local keys', () => {
    const cards = map(record(), { kind: 'notice', reason: 'store_not_confirmed' }, { kind: 'other_org' }, { kind: 'other_org' }, { kind: 'unsupported_provider' }, { kind: 'unsupported_provider' }).data.cards
    expect(cards).toHaveLength(4)
    expect(Object.keys(cards[0]).sort()).toEqual(['kind', 'key', 'provider', 'source', 'label', 'binding', 'grant', 'directoryManaged', 'boundAt'].sort())
    expect(cards.slice(1)).toEqual([
      { kind: 'notice', key: 'card-2', reason: 'store_not_confirmed' },
      { kind: 'notice', key: 'card-3', reason: 'other_org' },
      { kind: 'notice', key: 'card-4', reason: 'unsupported_provider' },
    ])
  })
  it.each(['identityId', 'connectionId', 'grantId', 'orgId', 'config', 'corp_id', 'profile'])('rejects additional fact field %s', field => {
    const sentinel = 'ac000001-0000-4000-8000-000000000001'
    expect(() => unchecked({ context: 'selected', items: [{ ...record(), [field]: sentinel }] }))
      .toThrowError(/^ACCOUNT_CENTER_STATE_UNREADABLE$/)
  })
  it('never derives card keys from display text', () => {
    const ids = ['ac000001-0000-4000-8000-000000000001', 'ac000002-0000-4000-8000-000000000002', 'ac000003-0000-4000-8000-000000000003', 'ac000004-0000-4000-8000-000000000004']
    const keys = map(...ids.map(label => record({ label }))).data.cards.map(card => card.key)
    expect(keys).toEqual(['card-1', 'card-2', 'card-3', 'card-4'])
    for (const id of ids) expect(JSON.stringify(keys)).not.toContain(id)
  })
  it.each([
    ['', '钉钉连接'], ['   ', '钉钉连接'], ['x'.repeat(121), '钉钉连接'],
    ['😀'.repeat(60), '😀'.repeat(60)], ['😀'.repeat(61), '钉钉连接'],
    ['  <b>Example</b>  ', '<b>Example</b>'],
  ])('normalizes display label %j', (label, expected) => {
    expect(map(record({ label })).data.cards[0]).toMatchObject({ label: expected })
  })
  it('uses the fixed legacy label and supplied directory fact', () => {
    expect(map(record({ source: 'legacy', label: 'Example' })).data.cards[0]).toMatchObject({ label: '钉钉关联', directoryManaged: false })
    expect(map(record({ directoryManaged: true })).data.cards[0]).toMatchObject({ directoryManaged: true })
  })
  it.each([
    { ...record(), source: 'other' }, { ...record(), provider: 'other' },
    { ...record(), grantMode: 'legacy_default' }, { ...record(), directoryManaged: 1 },
    { ...record(), source: 'legacy', directoryManaged: true },
    { ...record(), binding: 'not_bound' }, { ...record(), binding: 'other' },
    { ...record(), hasRevokedHistory: 'false' }, { ...record(), activeGrants: [{ enabled: 'true' }] },
    { ...record(), activeGrants: [{ enabled: true, extra: true }] },
    { ...record(), boundAt: '2026-02-30T03:04:05.000Z' },
    { ...record(), boundAt: '2026-01-02T03:04:05Z' },
    { ...record(), boundAt: '2026-01-02T03:04:05.000+00:00' },
    { kind: 'notice', reason: 'other_org' }, { kind: 'notice', reason: 'store_not_confirmed', label: 'Example' },
    { kind: 'other_org', label: 'Example' }, { kind: 'unsupported_provider', name: 'Example' },
    { kind: 'unknown' }, null,
  ])('rejects malformed fact %j', item => {
    expect(() => unchecked({ context: 'selected', items: [item] })).toThrowError(/^ACCOUNT_CENTER_STATE_UNREADABLE$/)
  })
  it('rejects missing and extra envelope or fact keys', () => {
    const item: Partial<AccountCenterRecordFact> = record()
    delete item.label
    for (const value of [null, [], {}, { context: 'other', items: [] }, { context: 'selected', items: [], extra: true }, { context: 'selected', items: [item] }]) {
      expect(() => unchecked(value)).toThrowError(/^ACCOUNT_CENTER_STATE_UNREADABLE$/)
    }
  })
  it('accepts only global legacy records without a selected organization', () => {
    expect(mapAccountCenterFacts({ context: 'selection_required', items: [record({ source: 'legacy' })] }).data.cards).toHaveLength(1)
    for (const item of [record(), { kind: 'other_org' }]) {
      expect(() => unchecked({ context: 'selection_required', items: [item] })).toThrowError(/^ACCOUNT_CENTER_STATE_UNREADABLE$/)
    }
  })
  it('does not modify the supplied facts', () => {
    const fact = Object.freeze(record({ activeGrants: Object.freeze([{ enabled: true }]) as { enabled: boolean }[] }))
    const facts = { context: 'selected' as const, items: [fact] }
    const before = JSON.stringify(facts)
    mapAccountCenterFacts(facts)
    expect(JSON.stringify(facts)).toBe(before)
  })
})
