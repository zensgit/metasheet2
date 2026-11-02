import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAttendanceOwningSessionUnitFixture,
  disposeAttendanceOwningSessionUnitFixtures,
} from '../../../tests/helpers/attendance-owning-session-unit-fixture'
import fs from 'node:fs'
import path from 'node:path'

import {
  ATTENDANCE_W4_CONNECTION_UNCERTAIN,
  AttendanceCleaningConnectionUncertainError,
  AttendanceW4ConnectionUncertainPrimitiveError,
  attendanceW4ConnectionDiscardV1,
  isAttendanceW4ConnectionUncertainV1,
  markAttendanceW4ConnectionUncertainV1,
  runAttendanceResultOperationHandedOverV1,
  runAttendanceResultOperationTransactionV1,
} from '../w4c0-operation-registry'
import { OnlinePunchConnectionUncertainError } from '../online-punch-request'
import { coordinatedTransactionV1 } from '../coordination/settlement-coordination-port'
import { ORG, REQUEST, setupFakeCoordination } from '../../../tests/helpers/settlement-coordination-fakes'

afterEach(disposeAttendanceOwningSessionUnitFixtures)

/** Unit-only managed checkout: protocol-idle on entry, scripted COMMIT / ROLLBACK. */
async function connection(script: { commit?: () => void; rollback?: () => void } = {}) {
  const sent: string[] = []
  const { client } = await createAttendanceOwningSessionUnitFixture(async (sql: string) => {
    sent.push(sql)
    if (sql === 'COMMIT') script.commit?.()
    if (sql === 'ROLLBACK') script.rollback?.()
    return { rows: [] }
  })
  return { sent, client }
}

const begins = (sent: readonly string[]) => sent.filter((sql) => sql.startsWith('BEGIN')).length
const sqlError = (code: string, message = `test: ${code}`) => Object.assign(new Error(message), { code })

describe('W4 runner — the uncertainty mark (r6.1 §1.1 P1-1 连接销毁语义)', () => {
  it.each(['T', 'E', '?'] as const)('refuses protocol %s without SQL, body, cleanup or uncertainty marking', async initialStatus => {
    const queryFailure = Object.freeze(sqlError('08006', 'must not reach query'))
    const query = vi.fn(async () => { throw queryFailure })
    const body = vi.fn(async () => 'unreachable')
    const { client } = await createAttendanceOwningSessionUnitFixture(query, { initialStatus })
    const failure = await runAttendanceResultOperationTransactionV1(client, body).catch(error => error)
    expect(failure).toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
    expect(isAttendanceW4ConnectionUncertainV1(failure)).toBe(false)
    expect(isAttendanceW4ConnectionUncertainV1(queryFailure)).toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('refuses a raw query-only wrapper even when its script claims idle', async () => {
    const query = vi.fn(async () => { throw { code: '25P01' } })
    const body = vi.fn(async () => 'unreachable')
    await expect(runAttendanceResultOperationTransactionV1({ query } as never, body))
      .rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
    expect(query).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('a failed ROLLBACK after a retryable body error: no second attempt on this connection, the same error object comes out marked, code and shape unchanged', async () => {
    const error = sqlError('40001')
    const keysBefore = Object.keys(error)
    const jsonBefore = JSON.stringify(error)
    const { sent, client } = await connection({
      rollback: () => {
        throw new Error('test: rollback failed')
      },
    })
    const failure = await runAttendanceResultOperationTransactionV1(client, async () => Promise.reject(error)).then(
      () => null,
      (thrown) => thrown,
    )
    expect(failure).toBe(error)
    expect((failure as { code: string }).code).toBe('40001')
    expect(isAttendanceW4ConnectionUncertainV1(failure)).toBe(true)
    expect(Object.keys(error)).toEqual(keysBefore)
    expect(JSON.stringify(error)).toBe(jsonBefore)
    expect(Object.getOwnPropertyDescriptor(error, ATTENDANCE_W4_CONNECTION_UNCERTAIN)).toMatchObject({ enumerable: false, writable: false, configurable: false })
    expect(begins(sent)).toBe(1)
  })

  it('a COMMIT that fails with anything but 40001 / 40P01 comes out marked; the cleanup ROLLBACK is still attempted once; no retry', async () => {
    const error = sqlError('57014')
    const { sent, client } = await connection({
      commit: () => {
        throw error
      },
    })
    const failure = await runAttendanceResultOperationTransactionV1(client, async () => 'ok').then(
      () => null,
      (thrown) => thrown,
    )
    expect(failure).toBe(error)
    expect(isAttendanceW4ConnectionUncertainV1(failure)).toBe(true)
    expect(sent.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1)
    expect(begins(sent)).toBe(1)
  })

  it('a COMMIT that fails with 40001 is not marked and is retried as before; the second attempt commits', async () => {
    let commits = 0
    const error = sqlError('40001')
    const { sent, client } = await connection({
      commit: () => {
        commits += 1
        if (commits === 1) throw error
      },
    })
    await expect(runAttendanceResultOperationTransactionV1(client, async () => 'ok')).resolves.toBe('ok')
    expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(false)
    expect(begins(sent)).toBe(2)
  })

  it('a body error with a successful ROLLBACK is not marked: a retryable one is retried, any other goes out unchanged after one attempt', async () => {
    const retryable = sqlError('40P01')
    let runs = 0
    const first = await connection()
    await expect(
      runAttendanceResultOperationTransactionV1(first.client, async () => {
        runs += 1
        if (runs === 1) throw retryable
        return 'second'
      }),
    ).resolves.toBe('second')
    expect(isAttendanceW4ConnectionUncertainV1(retryable)).toBe(false)
    expect(begins(first.sent)).toBe(2)

    const business = Object.assign(new Error('test: business'), { code: 'ATTENDANCE_TEST_BUSINESS' })
    const second = await connection()
    await expect(runAttendanceResultOperationTransactionV1(second.client, async () => Promise.reject(business))).rejects.toBe(business)
    expect(isAttendanceW4ConnectionUncertainV1(business)).toBe(false)
    expect(begins(second.sent)).toBe(1)
  })

  it('a frozen error object is remembered by identity: still recognised, still frozen, no property added', async () => {
    const error = Object.freeze(sqlError('40001', 'test: frozen'))
    const { client } = await connection({
      rollback: () => {
        throw new Error('test: rollback failed')
      },
    })
    await expect(runAttendanceResultOperationTransactionV1(client, async () => Promise.reject(error))).rejects.toBe(error)
    expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
    expect(Object.isFrozen(error)).toBe(true)
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
  })

  it('a thrown primitive cannot carry the mark: it travels as the cause of the registry error', async () => {
    const { client } = await connection({
      rollback: () => {
        throw new Error('test: rollback failed')
      },
    })
    const failure = await runAttendanceResultOperationTransactionV1(client, async () => Promise.reject('boom')).then(
      () => null,
      (thrown) => thrown,
    )
    expect(failure).toBeInstanceOf(AttendanceW4ConnectionUncertainPrimitiveError)
    expect(failure).toMatchObject({ code: 'W4C0_CONNECTION_UNCERTAIN', cause: 'boom' })
    expect(isAttendanceW4ConnectionUncertainV1(failure)).toBe(true)
  })

  it('the discard value is truthy for every uncertain value, so pg destroys the connection: a marked non-Error object travels as a registry error', () => {
    const plain = { code: 'ATTENDANCE_TEST_PLAIN' }
    expect(markAttendanceW4ConnectionUncertainV1(plain)).toBe(plain)
    const discard = attendanceW4ConnectionDiscardV1(plain)
    expect(discard).toBeInstanceOf(AttendanceW4ConnectionUncertainPrimitiveError)
    expect((discard as { cause?: unknown }).cause).toBe(plain)
    const error = markAttendanceW4ConnectionUncertainV1(new Error('marked')) as Error
    expect(attendanceW4ConnectionDiscardV1(error)).toBe(error)
    expect(attendanceW4ConnectionDiscardV1({ code: 'ATTENDANCE_TEST_UNMARKED' })).toBeUndefined()
    expect(attendanceW4ConnectionDiscardV1(new Error('unmarked'))).toBeUndefined()
    expect(attendanceW4ConnectionDiscardV1(undefined)).toBeUndefined()
  })

  it('the mark key is the registered symbol of the contract (§5.3), so another copy of the module reads the same mark', () => {
    expect(ATTENDANCE_W4_CONNECTION_UNCERTAIN).toBe(Symbol.for('ms2.attendance.w4.connectionUncertain'))
  })

  it('the predicate recognises the two uncertain classes that predate the mark, not a plain error; marking is idempotent', () => {
    expect(isAttendanceW4ConnectionUncertainV1(new AttendanceCleaningConnectionUncertainError())).toBe(true)
    expect(isAttendanceW4ConnectionUncertainV1(new OnlinePunchConnectionUncertainError())).toBe(true)
    expect(isAttendanceW4ConnectionUncertainV1(new Error('plain'))).toBe(false)
    expect(isAttendanceW4ConnectionUncertainV1(null)).toBe(false)
    expect(isAttendanceW4ConnectionUncertainV1('text')).toBe(false)
    const error = new Error('once')
    expect(markAttendanceW4ConnectionUncertainV1(error)).toBe(error)
    expect(markAttendanceW4ConnectionUncertainV1(error)).toBe(error)
    expect(Object.getOwnPropertySymbols(error)).toEqual([ATTENDANCE_W4_CONNECTION_UNCERTAIN])
  })

  it('the fenced path keeps its own class on a failed ROLLBACK (unchanged behaviour)', async () => {
    const { client } = await connection({
      rollback: () => {
        throw new Error('test: rollback failed')
      },
    })
    await expect(
      runAttendanceResultOperationTransactionV1(client, async () => Promise.reject(sqlError('40001')), {
        attendanceCleaningAuthority: true,
        attendanceCleaningSheetIds: ['sheet-a'],
      }),
    ).rejects.toBeInstanceOf(AttendanceCleaningConnectionUncertainError)
  })

  it('the fenced path keeps its own class on a COMMIT that fails with anything but 40001 / 40P01, and the COMMIT error itself is not marked (unchanged behaviour)', async () => {
    const commitError = sqlError('57014')
    const { sent, client } = await connection({
      commit: () => {
        throw commitError
      },
    })
    const failure = await runAttendanceResultOperationTransactionV1(client, async () => 'ok', {
      attendanceCleaningAuthority: true,
      attendanceCleaningSheetIds: ['sheet-a'],
    }).then(
      () => null,
      (thrown) => thrown,
    )
    expect(failure).toBeInstanceOf(AttendanceCleaningConnectionUncertainError)
    expect((failure as { code?: unknown }).code).toBe('W4C0_ATTENDANCE_CLEANING_CONNECTION_UNCERTAIN')
    expect(failure).not.toBe(commitError)
    expect(isAttendanceW4ConnectionUncertainV1(commitError)).toBe(false)
    expect(Object.getOwnPropertySymbols(commitError)).toEqual([])
    expect(begins(sent)).toBe(1)
    expect(sent.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    expect(sent.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1)
  })

  it('the handed-over runner marks nothing: its connection belongs to the port', async () => {
    const { coordinator, baseline } = setupFakeCoordination()
    const business = Object.assign(new Error('test: handed-over business'), { code: 'ATTENDANCE_TEST_BUSINESS' })
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => runAttendanceResultOperationHandedOverV1(context.client, async () => Promise.reject(business)),
      }),
    ).rejects.toBe(business)
    expect(isAttendanceW4ConnectionUncertainV1(business)).toBe(false)
    baseline()
  })
})

describe('same-connection wrappers check the mark before retrying (source-anchored until the control fixture exists)', () => {
  it('runControlTransaction refuses to retry a control precondition once the error carries the mark', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../w4c3a-rollout-control.ts'), 'utf8')
    const start = source.indexOf('async function runControlTransaction<T>(')
    const end = source.indexOf('\n}\n', start)
    const body = source.slice(start, end)
    const check = body.indexOf('if (isAttendanceW4ConnectionUncertainV1(error)) throw error')
    const retry = body.indexOf('if (attempt === 0 && isRetryableControlPrecondition(error)) continue')
    expect(check).toBeGreaterThan(-1)
    expect(retry).toBeGreaterThan(-1)
    expect(check).toBeLessThan(retry)
  })
})
