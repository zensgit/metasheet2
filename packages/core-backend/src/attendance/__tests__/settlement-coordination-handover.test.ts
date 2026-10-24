import { describe, expect, it } from 'vitest'

import {
  SettlementCoordinationCredentialV1,
  commitSettlementCoordinationTransactionV1,
  planSettlementCoordinationV1,
  releaseSettlementCoordinationSessionLocksV1,
  rollbackSettlementCoordinationTransactionV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  verifySettlementCoordinationCredentialV1,
} from '../coordination/settlement-coordination-handover'
import {
  buildSettlementCoordinationS1Sql,
  buildSettlementCoordinationS2Sql,
  buildSettlementCoordinationSessionUnlockSql,
} from '../coordination/settlement-coordination-statements'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'

const ORG = '0e4b1f8a-3c2d-4e5f-9a6b-7c8d9e0f1a2b'
const HANDOVER = { isolation: 'SERIALIZABLE' as const, timeouts: { kind: 'none' as const }, entryLabel: 'unit.test' }

type Reply = Array<Record<string, unknown>> | Error | Readonly<{ rows: Array<Record<string, unknown>>; command: string | null }>

/**
 * Records every query (text and whether values were passed) and answers from a script, so the
 * outcome mapping can be checked row by row without a database. Like node-postgres, a reply carries
 * the command tag; by default it is the statement's first keyword (`COMMIT` for COMMIT).
 */
class ScriptedClient implements AttendanceW4TransactionClientV1 {
  readonly calls: Array<{ text: string; hasParams: boolean }> = []
  onQuery: ((text: string) => void) | null = null

  constructor(private readonly replies: Reply[]) {}

  async query(sqlText: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; command: string | null }> {
    this.calls.push({ text: sqlText, hasParams: params !== undefined })
    this.onQuery?.(sqlText)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error(`unscripted query: ${sqlText}`)
    if (reply instanceof Error) throw reply
    if (Array.isArray(reply)) return { rows: reply, command: sqlText.trim().split(/\s+/)[0].toUpperCase() }
    return { rows: [...reply.rows], command: reply.command }
  }
}

function sqlError(code: string): Error {
  return Object.assign(new Error(`sql error ${code}`), { code })
}

describe('settlement coordination S1 outcome mapping (appendix E disposition table)', () => {
  const plan = planSettlementCoordinationV1(ORG, { needsClassZero: true })

  it('sends exactly the built S1 statement, once, with no values (simple protocol)', async () => {
    const client = new ScriptedClient([[{ idle: true, k_ok: true, c_ok: true, k_undo: null }]])
    expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
    expect(client.calls).toEqual([
      { text: buildSettlementCoordinationS1Sql({ key2: plan.key.key2, classZeroKey: plan.classZeroKey }), hasParams: false },
    ])
  })

  it.each([
    ['idle not true', [{ idle: false, k_ok: null, c_ok: null, k_undo: null }], { kind: 'uncertain', reason: 's1-not-idle' }],
    ['idle null', [{ idle: null, k_ok: null, c_ok: null, k_undo: null }], { kind: 'uncertain', reason: 's1-not-idle' }],
    ['dedicated key lost', [{ idle: true, k_ok: false, c_ok: null, k_undo: null }], { kind: 'contended', family: 'dedicated' }],
    ['both families taken', [{ idle: true, k_ok: true, c_ok: true, k_undo: null }], { kind: 'acquired' }],
    ['class-00 lost, undo true', [{ idle: true, k_ok: true, c_ok: false, k_undo: true }], { kind: 'contended', family: 'class-00' }],
    ['class-00 lost, undo false', [{ idle: true, k_ok: true, c_ok: false, k_undo: false }], { kind: 'uncertain', reason: 's1-undo-failed' }],
    ['class-00 lost, undo null', [{ idle: true, k_ok: true, c_ok: false, k_undo: null }], { kind: 'uncertain', reason: 's1-undo-failed' }],
    ['k_ok null while idle', [{ idle: true, k_ok: null, c_ok: null, k_undo: null }], { kind: 'uncertain', reason: 's1-result-invalid' }],
    ['c_ok null after k_ok', [{ idle: true, k_ok: true, c_ok: null, k_undo: null }], { kind: 'uncertain', reason: 's1-result-invalid' }],
    ['no row', [], { kind: 'uncertain', reason: 's1-result-invalid' }],
    ['two rows', [{ idle: true, k_ok: true, c_ok: true }, { idle: true, k_ok: true, c_ok: true }], { kind: 'uncertain', reason: 's1-result-invalid' }],
  ])('%s', async (_label, rows, expected) => {
    expect(await runSettlementCoordinationS1V1(new ScriptedClient([rows]), plan)).toEqual(expected)
  })

  it('a statement error (including 25P02) is uncertain and carries the original error', async () => {
    const error = sqlError('25P02')
    expect(await runSettlementCoordinationS1V1(new ScriptedClient([error]), plan)).toEqual({
      kind: 'uncertain',
      reason: 's1-statement-failed',
      error,
    })
  })
})

describe('settlement coordination handover outcome mapping', () => {
  const plan = planSettlementCoordinationV1(ORG, { needsClassZero: true })
  const s2 = buildSettlementCoordinationS2Sql({
    key2: plan.key.key2,
    classZeroKey: plan.classZeroKey,
    timeouts: HANDOVER.timeouts,
    entryLabel: HANDOVER.entryLabel,
  })
  const okRow = { x_k: true, x_c: true, u_k: true, u_c: true, an: 'ms2-coord:unit.test' }

  it('sends BEGIN on its own, then exactly the built S2, with no values', async () => {
    const client = new ScriptedClient([[], [okRow]])
    const outcome = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
    expect(outcome.kind).toBe('handed-over')
    expect(client.calls).toEqual([
      { text: 'BEGIN ISOLATION LEVEL SERIALIZABLE', hasParams: false },
      { text: s2, hasParams: false },
    ])
  })

  it.each([
    ['dedicated re-grant false', [{ ...okRow, x_k: false, u_k: null, u_c: null }], 's2-regrant-failed'],
    ['class-00 re-grant false', [{ ...okRow, x_c: false, u_k: null, u_c: null }], 's2-regrant-failed'],
    ['dedicated unlock false', [{ ...okRow, u_k: false }], 's2-unlock-failed'],
    ['class-00 unlock false', [{ ...okRow, u_c: false }], 's2-unlock-failed'],
    ['no row', [], 's2-result-invalid'],
  ])('%s rolls back and is uncertain', async (_label, rows, reason) => {
    const client = new ScriptedClient([[], rows, []])
    expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({ kind: 'uncertain', reason })
    expect(client.calls.map((call) => call.text)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', s2, 'ROLLBACK'])
  })

  it('an S2 error rolls back and is uncertain; a failing ROLLBACK there does not change the outcome', async () => {
    const error = sqlError('57014')
    const client = new ScriptedClient([[], error, sqlError('08006')])
    expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({
      kind: 'uncertain',
      reason: 's2-statement-failed',
      error,
    })
    expect(client.calls.map((call) => call.text)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', s2, 'ROLLBACK'])
  })

  it('a BEGIN answered without the BEGIN tag is uncertain before anything runs inside the transaction', async () => {
    const client = new ScriptedClient([{ rows: [], command: null }, []])
    expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({ kind: 'uncertain', reason: 'begin-unacknowledged' })
    expect(client.calls.map((call) => call.text)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK'])
  })

  it('a BEGIN error is uncertain and sends nothing else', async () => {
    const error = sqlError('08006')
    const client = new ScriptedClient([error])
    expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({ kind: 'uncertain', reason: 'begin-failed', error })
    expect(client.calls).toHaveLength(1)
  })

  it('rejects an isolation level outside the three named ones before sending anything', async () => {
    const client = new ScriptedClient([])
    await expect(
      runSettlementCoordinationHandoverV1(client, plan, { ...HANDOVER, isolation: 'READ UNCOMMITTED' as never }),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_ISOLATION_INVALID' })
    expect(client.calls).toHaveLength(0)
  })
})

describe('settlement coordination transaction end', () => {
  const plan = planSettlementCoordinationV1(ORG, { needsClassZero: true })
  const okRow = { x_k: true, x_c: true, u_k: true, u_c: true, an: 'ms2-coord:unit.test' }

  async function handedOver(client: ScriptedClient): Promise<SettlementCoordinationCredentialV1> {
    const outcome = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
    if (outcome.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(outcome)}`)
    return outcome.credential
  }

  function credentialLiveAt(client: ScriptedClient, credential: SettlementCoordinationCredentialV1, statement: string): boolean[] {
    const seen: boolean[] = []
    client.onQuery = (text) => {
      if (text === statement) seen.push(verifySettlementCoordinationCredentialV1(client, credential, ORG, { needsClassZero: true }))
    }
    return seen
  }

  it.each([
    ['success', [], { kind: 'committed' }],
    ['40001', sqlError('40001'), 'retryable'],
    ['40P01', sqlError('40P01'), 'retryable'],
    ['08006', sqlError('08006'), 'uncertain'],
    ['57P01', sqlError('57P01'), 'uncertain'],
    ['no code', new Error('socket hang up'), 'uncertain'],
  ])('COMMIT %s: credential is already invalid when COMMIT is sent', async (_label, reply, expected) => {
    const client = new ScriptedClient([[], [okRow], reply as Reply])
    const credential = await handedOver(client)
    expect(verifySettlementCoordinationCredentialV1(client, credential, ORG, { needsClassZero: true })).toBe(true)
    const seen = credentialLiveAt(client, credential, 'COMMIT')
    const outcome = await commitSettlementCoordinationTransactionV1(client, credential)
    if (typeof expected === 'string') {
      expect(outcome.kind).toBe(expected)
      if (expected === 'uncertain') expect(outcome).toMatchObject({ reason: 'commit-failed', error: reply })
      if (expected === 'retryable') expect(outcome).toMatchObject({ error: reply })
    } else {
      expect(outcome).toEqual(expected)
    }
    expect(seen).toEqual([false])
    expect(verifySettlementCoordinationCredentialV1(client, credential, ORG, { needsClassZero: true })).toBe(false)
  })

  it.each([
    ['success', [], { kind: 'rolled-back' }],
    ['error', sqlError('08006'), 'uncertain'],
  ])('ROLLBACK %s: credential is already invalid when ROLLBACK is sent', async (_label, reply, expected) => {
    const client = new ScriptedClient([[], [okRow], reply as Reply])
    const credential = await handedOver(client)
    const seen = credentialLiveAt(client, credential, 'ROLLBACK')
    const outcome = await rollbackSettlementCoordinationTransactionV1(client, credential)
    if (typeof expected === 'string') expect(outcome).toMatchObject({ kind: 'uncertain', reason: 'rollback-failed', error: reply })
    else expect(outcome).toEqual(expected)
    expect(seen).toEqual([false])
  })
})

describe('settlement coordination session-lock cleanup mapping', () => {
  const plan = planSettlementCoordinationV1(ORG, { needsClassZero: true })

  it('sends exactly the built unlock statement and requires both unlocks to be true', async () => {
    const client = new ScriptedClient([[{ u_k: true, u_c: true }]])
    expect(await releaseSettlementCoordinationSessionLocksV1(client, plan)).toEqual({ kind: 'released' })
    expect(client.calls).toEqual([
      { text: buildSettlementCoordinationSessionUnlockSql({ key2: plan.key.key2, classZeroKey: plan.classZeroKey }), hasParams: false },
    ])
  })

  it.each([
    ['dedicated false', [{ u_k: false, u_c: true }]],
    ['class-00 false', [{ u_k: true, u_c: false }]],
    ['null', [{ u_k: null, u_c: true }]],
    ['no row', []],
  ])('%s is uncertain', async (_label, rows) => {
    expect(await releaseSettlementCoordinationSessionLocksV1(new ScriptedClient([rows]), plan)).toEqual({
      kind: 'uncertain',
      reason: 'unlock-returned-false',
    })
  })

  it('a statement error is uncertain', async () => {
    const error = sqlError('08006')
    expect(await releaseSettlementCoordinationSessionLocksV1(new ScriptedClient([error]), plan)).toEqual({
      kind: 'uncertain',
      reason: 'unlock-statement-failed',
      error,
    })
  })
})

describe('settlement coordination transaction end — what COMMIT proves and who may end the transaction', () => {
  const plan = planSettlementCoordinationV1(ORG, { needsClassZero: true })
  const okRow = { x_k: true, x_c: true, u_k: true, u_c: true, an: 'ms2-coord:unit.test' }

  async function handedOver(client: ScriptedClient): Promise<SettlementCoordinationCredentialV1> {
    const outcome = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
    if (outcome.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(outcome)}`)
    return outcome.credential
  }

  it.each([
    ['ROLLBACK (the transaction had already failed)', 'ROLLBACK'],
    ['no tag', null],
    ['an unexpected tag', 'SELECT'],
  ])('COMMIT answered with %s is uncertain, never committed', async (_label, command) => {
    const client = new ScriptedClient([[], [okRow], { rows: [], command }])
    const credential = await handedOver(client)
    const outcome = await commitSettlementCoordinationTransactionV1(client, credential)
    expect(outcome).toMatchObject({ kind: 'uncertain', reason: 'commit-not-committed' })
    const error = (outcome as { error?: { code?: unknown; command?: unknown } }).error
    expect(error?.code).toBe('ATTENDANCE_COORDINATION_COMMIT_NOT_COMMITTED')
    expect(error?.command).toBe(command)
    expect(verifySettlementCoordinationCredentialV1(client, credential, ORG, { needsClassZero: true })).toBe(false)
  })

  it.each([
    ['COMMIT', commitSettlementCoordinationTransactionV1],
    ['ROLLBACK', rollbackSettlementCoordinationTransactionV1],
  ] as const)('%s through a connection other than the credential\'s throws and sends nothing', async (_label, end) => {
    const owner = new ScriptedClient([[], [okRow]])
    const stranger = new ScriptedClient([])
    const credential = await handedOver(owner)
    await expect(end(stranger, credential)).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH' })
    expect(stranger.calls).toEqual([])
    // The owning transaction keeps its live credential, so its owner can still end it.
    expect(verifySettlementCoordinationCredentialV1(owner, credential, ORG, { needsClassZero: true })).toBe(true)
  })

  it('a credential that already ended its transaction cannot end another', async () => {
    const client = new ScriptedClient([[], [okRow], []])
    const credential = await handedOver(client)
    expect(await commitSettlementCoordinationTransactionV1(client, credential)).toEqual({ kind: 'committed' })
    await expect(rollbackSettlementCoordinationTransactionV1(client, credential)).rejects.toMatchObject({
      code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH',
    })
    expect(client.calls.map((call) => call.text).filter((text) => text === 'ROLLBACK')).toEqual([])
  })

  it('a forged object with the credential prototype is refused, not a TypeError', async () => {
    const client = new ScriptedClient([])
    const forged = Object.create(SettlementCoordinationCredentialV1.prototype) as SettlementCoordinationCredentialV1
    expect(verifySettlementCoordinationCredentialV1(client, forged, ORG, { needsClassZero: false })).toBe(false)
    await expect(commitSettlementCoordinationTransactionV1(client, forged)).rejects.toMatchObject({
      code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH',
    })
    expect(client.calls).toEqual([])
  })
})
