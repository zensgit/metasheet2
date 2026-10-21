import { describe, expect, it } from 'vitest'

import {
  claimElearningCredit,
  claimElearningCreditInTransaction,
  ElearningCreditLedgerError,
  type ClaimElearningCreditInput,
  type ElearningCreditDecisionRow,
  type ElearningCreditEffectClaimInput,
  type ElearningCreditExistingEffect,
  type ElearningCreditLedgerStore,
  type ElearningCreditLedgerTx,
} from '../../src/services/elearning-credit-ledger'
import {
  ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  hashElearningCreditEffect,
  type ElearningCreditRuleSnapshotInput,
} from '../../src/services/elearning-credit-policy'

const ORG_A = 'org-credit-a'
const ORG_B = 'org-credit-b'
const USER = 'user-credit-a'
const EFFECT_KEY = 'attempt:attempt-a'
const RULE_ID = 'rule-pass-exam'
const ENABLED: NodeJS.ProcessEnv = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
}
const FLAG_LOOKALIKES: Array<string | undefined> = [
  undefined,
  '',
  'false',
  'FALSE',
  '0',
  '1',
  'yes',
  'on',
  'TRUE',
  'True',
  ' true',
  'true ',
]

const baseRule = (
  over: Partial<ElearningCreditRuleSnapshotInput> = {},
): ElearningCreditRuleSnapshotInput => ({
  dailyCap: 10,
  id: RULE_ID,
  points: 10,
  timeZone: 'Asia/Shanghai',
  version: 1,
  ...over,
})

const baseInput = (over: Partial<ClaimElearningCreditInput> = {}): ClaimElearningCreditInput => ({
  behavior: 'pass_exam',
  effectKey: EFFECT_KEY,
  occurredAt: '2026-03-08T06:59:59.000Z',
  orgId: ORG_A,
  reference: { attemptId: 'attempt-a', source: { kind: 'exam', version: 1 } },
  userId: USER,
  ...over,
})

function effectKeyOf(identity: {
  orgId: string
  userId: string
  behavior: string
  effectKey: string
}): string {
  return `${identity.orgId}\0${identity.userId}\0${identity.behavior}\0${identity.effectKey}`
}

function ruleKeyOf(orgId: string, behavior: string): string {
  return `${orgId}\0${behavior}`
}

function balanceKeyOf(orgId: string, userId: string): string {
  return `${orgId}\0${userId}`
}

interface FakeState {
  balances: Map<string, number>
  claims: Map<string, {
    decisionId: string
    requestHash: string
    requestHashVersion: number
  }>
  decisions: ElearningCreditDecisionRow[]
  effects: Map<string, ElearningCreditExistingEffect>
  rules: Map<string, ElearningCreditRuleSnapshotInput>
}

class FakeLedger implements ElearningCreditLedgerStore, ElearningCreditLedgerTx {
  balances = new Map<string, number>()
  calls: string[] = []
  claims = new Map<string, {
    decisionId: string
    requestHash: string
    requestHashVersion: number
  }>()
  decisions: ElearningCreditDecisionRow[] = []
  effects = new Map<string, ElearningCreditExistingEffect>()
  failOn: 'append' | 'balance' | null = null
  rules = new Map<string, ElearningCreditRuleSnapshotInput>()
  transactionCount = 0

  constructor(seed: {
    balances?: Array<{ orgId: string; userId: string; points: number }>
    decisions?: ElearningCreditDecisionRow[]
    rules?: Array<{ orgId: string; behavior: string; rule: ElearningCreditRuleSnapshotInput }>
  } = {}) {
    for (const row of seed.rules ?? []) {
      this.rules.set(ruleKeyOf(row.orgId, row.behavior), row.rule)
    }
    for (const row of seed.decisions ?? []) {
      this.decisions.push({ ...row, rule: { ...row.rule } })
    }
    for (const row of seed.balances ?? []) {
      this.balances.set(balanceKeyOf(row.orgId, row.userId), row.points)
    }
  }

  seedRule(orgId: string, behavior: string, rule: ElearningCreditRuleSnapshotInput): void {
    this.rules.set(ruleKeyOf(orgId, behavior), rule)
  }

  private snapshot(): FakeState {
    return {
      balances: new Map(this.balances),
      claims: new Map(
        [...this.claims.entries()].map(([key, value]) => [key, { ...value }]),
      ),
      decisions: this.decisions.map((row) => ({ ...row, rule: { ...row.rule } })),
      effects: new Map(
        [...this.effects.entries()].map(([key, value]) => [key, { ...value }]),
      ),
      rules: new Map(
        [...this.rules.entries()].map(([key, value]) => [key, { ...value }]),
      ),
    }
  }

  private restore(state: FakeState): void {
    this.balances = state.balances
    this.claims = state.claims
    this.decisions = state.decisions
    this.effects = state.effects
    this.rules = state.rules
  }

  async transaction<T>(handler: (tx: ElearningCreditLedgerTx) => Promise<T>): Promise<T> {
    this.transactionCount += 1
    const snapshot = this.snapshot()
    try {
      return await handler(this)
    } catch (error) {
      this.restore(snapshot)
      throw error
    }
  }

  async claimEffect(input: ElearningCreditEffectClaimInput) {
    this.calls.push('claimEffect')
    const key = effectKeyOf(input)
    const existing = this.effects.get(key)
    if (existing) return { effect: existing, kind: 'existing' as const }
    if (this.claims.has(key)) throw new Error('fake incomplete claim')
    this.claims.set(key, {
      decisionId: input.decisionId,
      requestHash: input.requestHash,
      requestHashVersion: input.requestHashVersion,
    })
    return { kind: 'claimed' as const }
  }

  async resolveActiveRule(input: {
    orgId: string
    behavior: string
  }): Promise<ElearningCreditRuleSnapshotInput | null> {
    this.calls.push('resolveActiveRule')
    const rule = this.rules.get(ruleKeyOf(input.orgId, input.behavior))
    return rule ? { ...rule } : null
  }

  async lockBucket(): Promise<void> {
    this.calls.push('lockBucket')
  }

  async sumPositiveAwards(input: {
    orgId: string
    userId: string
    behavior: string
    localDay: string
  }): Promise<number> {
    this.calls.push('sumPositiveAwards')
    return this.decisions.reduce((sum, row) => {
      if (
        row.orgId !== input.orgId
        || row.userId !== input.userId
        || row.behavior !== input.behavior
        || row.localDay !== input.localDay
        || row.awardedPoints <= 0
      ) return sum
      return sum + row.awardedPoints
    }, 0)
  }

  async appendDecision(row: ElearningCreditDecisionRow): Promise<void> {
    this.calls.push('appendDecision')
    if (this.failOn === 'append') throw new Error(`append failed for ${row.orgId}`)
    this.decisions.push({ ...row, rule: { ...row.rule } })
    this.effects.set(effectKeyOf(row), {
      awardedPoints: row.awardedPoints,
      id: row.id,
      requestHash: row.requestHash,
      requestHashVersion: row.requestHashVersion,
      status: row.status,
    })
  }

  async applyBalanceDelta(input: {
    orgId: string
    userId: string
    delta: number
  }): Promise<void> {
    this.calls.push('applyBalanceDelta')
    if (this.failOn === 'balance') throw new Error(`balance failed for ${input.orgId}`)
    const key = balanceKeyOf(input.orgId, input.userId)
    this.balances.set(key, (this.balances.get(key) ?? 0) + input.delta)
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningCreditLedgerError)
  const ledgerError = error as ElearningCreditLedgerError
  expect(ledgerError.code).toBe(code)
  const text = `${ledgerError.message}\n${ledgerError.stack ?? ''}\n${JSON.stringify(ledgerError)}`
  expect(text).not.toContain(ORG_A)
  expect(text).not.toContain(ORG_B)
  expect(text).not.toContain(USER)
  expect(text).not.toContain(EFFECT_KEY)
  expect(text).not.toContain(RULE_ID)
  expect(text).not.toContain('attempt-a')
  expect(text).not.toContain('Asia/Shanghai')
}

function expectClosedResult(result: {
  awardedPoints: number
  decisionId: string
  duplicate: boolean
  status: string
}): void {
  expect(Object.keys(result).sort()).toEqual([
    'awardedPoints',
    'decisionId',
    'duplicate',
    'status',
  ])
  const text = JSON.stringify(result)
  expect(text).not.toContain('reference')
  expect(text).not.toContain(RULE_ID)
  expect(text).not.toContain('attemptId')
  expect(text).not.toContain('Asia/Shanghai')
  expect(text).not.toContain('timeZone')
}

async function expectThrown(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action()
    throw new Error('expected ledger error')
  } catch (error) {
    if (error instanceof Error && error.message === 'expected ledger error') throw error
    expectCode(error, code)
  }
}

describe('elearning credit ledger', () => {
  it('reuses a caller-owned transaction without opening a nested transaction', async () => {
    const tx = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })

    const result = await claimElearningCreditInTransaction(tx, baseInput(), ENABLED)

    expect(result).toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
    expect(tx.transactionCount).toBe(0)
    expect(tx.calls).toEqual([
      'claimEffect',
      'resolveActiveRule',
      'lockBucket',
      'sumPositiveAwards',
      'appendDecision',
      'applyBalanceDelta',
    ])
  })

  it('fails closed with zero writes unless both flags are exact literal true', async () => {
    const input = baseInput()
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_INCENTIVE_ENABLED: 'true' },
      ...FLAG_LOOKALIKES.flatMap((value) => [
        { ELEARNING_ENABLED: value, ELEARNING_INCENTIVE_ENABLED: 'true' },
        { ELEARNING_ENABLED: 'true', ELEARNING_INCENTIVE_ENABLED: value },
      ]),
    ]
    for (const env of cases) {
      const store = new FakeLedger({
        rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
      })
      await expectThrown(() => claimElearningCredit(store, input, env), 'disabled')
      expect(store.transactionCount).toBe(0)
      expect(store.decisions).toEqual([])
      expect(store.balances.size).toBe(0)
      expect(store.calls).toEqual([])
    }
  })

  it('awards a new effect, snapshots the rule, and applies a nonzero balance delta', async () => {
    const store = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    const input = baseInput()
    const result = await claimElearningCredit(store, input, ENABLED)

    expectClosedResult(result)
    expect(result).toMatchObject({
      awardedPoints: 10,
      duplicate: false,
      status: 'awarded',
    })
    expect(result.decisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(store.calls).toEqual([
      'claimEffect',
      'resolveActiveRule',
      'lockBucket',
      'sumPositiveAwards',
      'appendDecision',
      'applyBalanceDelta',
    ])
    expect(store.decisions).toHaveLength(1)
    expect(store.decisions[0]).toMatchObject({
      awardedPoints: 10,
      behavior: 'pass_exam',
      effectKey: EFFECT_KEY,
      localDay: '2026-03-08',
      orgId: ORG_A,
      remainingDailyCap: 0,
      requestHash: hashElearningCreditEffect(input),
      requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
      requestedPoints: 10,
      status: 'awarded',
      userId: USER,
    })
    expect(store.decisions[0]?.rule).toEqual({
      dailyCap: 10,
      id: RULE_ID,
      points: 10,
      timeZone: 'Asia/Shanghai',
      version: 1,
    })
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(10)
  })

  it('caps a partial award against prior positive grants in the same local day', async () => {
    const prior = {
      awardedPoints: 7,
      behavior: 'pass_exam' as const,
      effectKey: 'attempt:prior',
      id: '11111111-1111-4111-8111-111111111111',
      localDay: '2026-03-08',
      occurredAt: '2026-03-08T01:00:00.000Z',
      orgId: ORG_A,
      remainingDailyCap: 3,
      requestHash: 'a'.repeat(64),
      requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
      requestedPoints: 7,
      rule: {
        dailyCap: 10,
        id: RULE_ID,
        points: 7,
        timeZone: 'Asia/Shanghai',
        version: 1,
      },
      status: 'awarded' as const,
      userId: USER,
    }
    const store = new FakeLedger({
      decisions: [prior],
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    const result = await claimElearningCredit(store, baseInput(), ENABLED)

    expectClosedResult(result)
    expect(result).toMatchObject({
      awardedPoints: 3,
      duplicate: false,
      status: 'capped',
    })
    expect(store.decisions).toHaveLength(2)
    expect(store.decisions[1]).toMatchObject({
      awardedPoints: 3,
      remainingDailyCap: 0,
      requestedPoints: 10,
      status: 'capped',
    })
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(3)
    expect(store.calls.includes('applyBalanceDelta')).toBe(true)
  })

  it('appends an exhausted zero decision without touching balance', async () => {
    const prior = {
      awardedPoints: 10,
      behavior: 'pass_exam' as const,
      effectKey: 'attempt:prior',
      id: '11111111-1111-4111-8111-111111111111',
      localDay: '2026-03-08',
      occurredAt: '2026-03-08T01:00:00.000Z',
      orgId: ORG_A,
      remainingDailyCap: 0,
      requestHash: 'a'.repeat(64),
      requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
      requestedPoints: 10,
      rule: {
        dailyCap: 10,
        id: RULE_ID,
        points: 10,
        timeZone: 'Asia/Shanghai',
        version: 1,
      },
      status: 'awarded' as const,
      userId: USER,
    }
    const store = new FakeLedger({
      balances: [{ orgId: ORG_A, points: 10, userId: USER }],
      decisions: [prior],
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    const result = await claimElearningCredit(store, baseInput(), ENABLED)

    expectClosedResult(result)
    expect(result).toMatchObject({
      awardedPoints: 0,
      duplicate: false,
      status: 'exhausted',
    })
    expect(store.decisions).toHaveLength(2)
    expect(store.decisions[1]).toMatchObject({
      awardedPoints: 0,
      remainingDailyCap: 0,
      requestedPoints: 10,
      status: 'exhausted',
    })
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(10)
    expect(store.calls.includes('appendDecision')).toBe(true)
    expect(store.calls.includes('applyBalanceDelta')).toBe(false)
  })

  it('returns the original row for a same-payload retry after the active rule changes', async () => {
    const store = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    const input = baseInput()
    const first = await claimElearningCredit(store, input, ENABLED)
    store.seedRule(ORG_A, 'pass_exam', baseRule({ points: 99, version: 2 }))
    store.calls = []

    const replay = await claimElearningCredit(store, {
      ...input,
      reference: { source: { version: 1, kind: 'exam' }, attemptId: 'attempt-a' },
    }, ENABLED)

    expectClosedResult(replay)
    expect(replay).toEqual({
      awardedPoints: first.awardedPoints,
      decisionId: first.decisionId,
      duplicate: true,
      status: first.status,
    })
    expect(replay.awardedPoints).toBe(10)
    expect(store.decisions).toHaveLength(1)
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(10)
    expect(store.calls).toEqual(['claimEffect'])
    expect(store.calls.includes('resolveActiveRule')).toBe(false)
  })

  it('claims the global effect identity before resolving a rule or locking a day bucket', async () => {
    const input = baseInput()
    const store = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    const result = await claimElearningCredit(store, input, ENABLED)

    expect(result.duplicate).toBe(false)
    expect(store.calls).toEqual([
      'claimEffect',
      'resolveActiveRule',
      'lockBucket',
      'sumPositiveAwards',
      'appendDecision',
      'applyBalanceDelta',
    ])
    expect(store.claims.get(effectKeyOf(input))?.decisionId).toBe(result.decisionId)
  })

  it('conflicts when the same effect key arrives with a different payload', async () => {
    const store = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    await claimElearningCredit(store, baseInput(), ENABLED)
    store.calls = []

    await expectThrown(
      () => claimElearningCredit(store, baseInput({
        occurredAt: '2026-03-08T07:00:00.000Z',
      }), ENABLED),
      'conflict',
    )
    await expectThrown(
      () => claimElearningCredit(store, baseInput({
        reference: { attemptId: 'attempt-b', source: { kind: 'exam', version: 1 } },
      }), ENABLED),
      'conflict',
    )
    expect(store.decisions).toHaveLength(1)
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(10)
    expect(store.calls).toEqual(['claimEffect', 'claimEffect'])
  })

  it('fails closed when a persisted automatic decision has impossible points', async () => {
    const input = baseInput()
    const impossible = [
      { awardedPoints: -5, status: 'awarded' as const },
      { awardedPoints: 0, status: 'awarded' as const },
      { awardedPoints: 0, status: 'capped' as const },
      { awardedPoints: 10, status: 'exhausted' as const },
    ]

    for (const effect of impossible) {
      const store = new FakeLedger()
      store.effects.set(effectKeyOf(input), {
        ...effect,
        id: '33333333-3333-4333-8333-333333333333',
        requestHash: hashElearningCreditEffect(input),
        requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
      })

      await expectThrown(() => claimElearningCredit(store, input, ENABLED), 'unavailable')
      expect(store.calls).toEqual(['claimEffect'])
      expect(store.decisions).toEqual([])
      expect(store.balances.size).toBe(0)
    }
  })

  it('keeps identical user and effect keys independent across orgs', async () => {
    const store = new FakeLedger({
      rules: [
        { behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() },
        { behavior: 'pass_exam', orgId: ORG_B, rule: baseRule({ points: 4 }) },
      ],
    })
    const first = await claimElearningCredit(store, baseInput(), ENABLED)
    const second = await claimElearningCredit(store, baseInput({ orgId: ORG_B }), ENABLED)

    expectClosedResult(first)
    expectClosedResult(second)
    expect(first.decisionId).not.toBe(second.decisionId)
    expect(first).toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
    expect(second).toMatchObject({ awardedPoints: 4, duplicate: false, status: 'awarded' })
    expect(store.decisions).toHaveLength(2)
    expect(store.balances.get(balanceKeyOf(ORG_A, USER))).toBe(10)
    expect(store.balances.get(balanceKeyOf(ORG_B, USER))).toBe(4)
  })

  it('rolls back persisted state when append or balance fails', async () => {
    const appendStore = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    appendStore.failOn = 'append'
    await expectThrown(
      () => claimElearningCredit(appendStore, baseInput(), ENABLED),
      'unavailable',
    )
    expect(appendStore.decisions).toEqual([])
    expect(appendStore.effects.size).toBe(0)
    expect(appendStore.claims.size).toBe(0)
    expect(appendStore.balances.size).toBe(0)

    const balanceStore = new FakeLedger({
      rules: [{ behavior: 'pass_exam', orgId: ORG_A, rule: baseRule() }],
    })
    balanceStore.failOn = 'balance'
    await expectThrown(
      () => claimElearningCredit(balanceStore, baseInput(), ENABLED),
      'unavailable',
    )
    expect(balanceStore.decisions).toEqual([])
    expect(balanceStore.effects.size).toBe(0)
    expect(balanceStore.claims.size).toBe(0)
    expect(balanceStore.balances.size).toBe(0)
  })

  it('rejects deferred manual_adjust and keeps results values-free', async () => {
    const store = new FakeLedger({
      rules: [{ behavior: 'manual_adjust', orgId: ORG_A, rule: baseRule({ points: -1 }) }],
    })
    await expectThrown(
      () => claimElearningCredit(store, baseInput({
        behavior: 'manual_adjust',
        reference: { reason: 'admin-grant', attemptId: 'attempt-a' },
      }), ENABLED),
      'unsupported_behavior',
    )
    expect(store.transactionCount).toBe(0)
    expect(store.decisions).toEqual([])

    const leaking: ElearningCreditLedgerStore = {
      transaction: async () => {
        throw new Error(`commit failed for ${ORG_A} ${USER} ${RULE_ID}`)
      },
    }
    await expectThrown(
      () => claimElearningCredit(leaking, baseInput(), ENABLED),
      'unavailable',
    )
  })
})
