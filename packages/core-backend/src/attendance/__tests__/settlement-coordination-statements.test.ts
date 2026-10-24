import { describe, expect, it } from 'vitest'

import { AttendanceCoordinationKeyError } from '../coordination/settlement-coordination-key'
import {
  buildSettlementCoordinationS1Sql,
  buildSettlementCoordinationS2Sql,
  buildSettlementCoordinationSessionUnlockSql,
} from '../coordination/settlement-coordination-statements'

const C00 = 1234567890123n

function assertSimpleProtocolSafe(sql: string): void {
  expect(sql).not.toMatch(/\$\d/) // no bind placeholders: simple query protocol only
  expect(sql).not.toContain(';') // exactly one statement
  expect(sql.toLowerCase()).not.toContain('pg_locks') // S1 / S2 never read pg_locks
  expect(sql.toLowerCase()).not.toContain('pg_advisory_unlock_all')
}

describe('settlement coordination S1', () => {
  it('matches the appendix E shape for a canonical org that needs class-00', () => {
    const sql = buildSettlementCoordinationS1Sql({ key2: -42, classZeroKey: C00 })
    expect(sql).toBe([
      'SELECT idle, k_ok, c_ok,',
      '       CASE WHEN k_ok AND c_ok IS NOT TRUE THEN pg_advisory_unlock_shared((1297297987)::int4, (-42)::int4) END AS k_undo',
      '  FROM (SELECT idle, k_ok,',
      '               CASE WHEN k_ok THEN pg_try_advisory_lock_shared((1234567890123)::bigint) END AS c_ok',
      '          FROM (SELECT idle,',
      '                       CASE WHEN idle THEN pg_try_advisory_lock_shared((1297297987)::int4, (-42)::int4) END AS k_ok',
      '                  FROM (SELECT now() = statement_timestamp() AS idle OFFSET 0) p',
      '                OFFSET 0) a',
      '        OFFSET 0) b',
    ].join('\n'))
    assertSimpleProtocolSafe(sql)
  })

  it('drops the class-00 layer when there is no class-00 key (legacy org, or entry without that family)', () => {
    const sql = buildSettlementCoordinationS1Sql({ key2: 7, classZeroKey: null })
    expect(sql).toBe([
      'SELECT idle, k_ok, true AS c_ok, NULL::boolean AS k_undo',
      '  FROM (SELECT idle, CASE WHEN idle THEN pg_try_advisory_lock_shared((1297297987)::int4, (7)::int4) END AS k_ok',
      '          FROM (SELECT now() = statement_timestamp() AS idle OFFSET 0) p',
      '        OFFSET 0) a',
    ].join('\n'))
    expect(sql).not.toContain('bigint')
    assertSimpleProtocolSafe(sql)
  })

  it('formats the int4 extremes so they still type-check', () => {
    expect(buildSettlementCoordinationS1Sql({ key2: -2147483648, classZeroKey: null })).toContain('(-2147483648)::int4')
    expect(buildSettlementCoordinationS1Sql({ key2: 2147483647, classZeroKey: null })).toContain('(2147483647)::int4')
  })

  it('refuses anything that is not an integer of the right width before formatting', () => {
    const bad: Array<[number, bigint | null]> = [
      [2147483648, null],
      [-2147483649, null],
      [1.5, null],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
    ]
    for (const [key2, classZeroKey] of bad) {
      expect(() => buildSettlementCoordinationS1Sql({ key2, classZeroKey })).toThrow(AttendanceCoordinationKeyError)
    }
    expect(() => buildSettlementCoordinationS1Sql({ key2: '1; SELECT 1' as unknown as number, classZeroKey: null }))
      .toThrow(AttendanceCoordinationKeyError)
    expect(() => buildSettlementCoordinationS1Sql({ key2: 1, classZeroKey: 5 as unknown as bigint }))
      .toThrow(AttendanceCoordinationKeyError)
  })
})

describe('settlement coordination S2', () => {
  it('runs the W4 runner settings for entries that go through the runner today', () => {
    const sql = buildSettlementCoordinationS2Sql({ key2: -42, classZeroKey: C00, timeouts: { kind: 'w4-runner' }, entryLabel: 'm13.request' })
    expect(sql).toBe([
      'SELECT x_k, x_c,',
      '       CASE WHEN x_k AND x_c THEN pg_advisory_unlock_shared((1297297987)::int4, (-42)::int4) END AS u_k,',
      '       CASE WHEN x_k AND x_c THEN pg_advisory_unlock_shared((1234567890123)::bigint) END AS u_c,',
      "       set_config('statement_timeout', '180000', true) AS st,",
      "       set_config('lock_timeout', '5000', true) AS lt,",
      "       set_config('application_name', 'ms2-coord:m13.request', true) AS an",
      '  FROM (SELECT x_k, CASE WHEN x_k THEN pg_try_advisory_xact_lock_shared((1234567890123)::bigint) END AS x_c',
      '          FROM (SELECT pg_try_advisory_xact_lock_shared((1297297987)::int4, (-42)::int4) AS x_k OFFSET 0) s1',
      '        OFFSET 0) s2',
    ].join('\n'))
    assertSimpleProtocolSafe(sql)
  })

  it('sets only lock_timeout for lock-timeout-only entries (M07, C4-27, C4-28, admin close)', () => {
    const sql = buildSettlementCoordinationS2Sql({
      key2: 9,
      classZeroKey: null,
      timeouts: { kind: 'lock-timeout-only', lockTimeoutMs: 5000 },
      entryLabel: 'm07.cancel-round.approve',
    })
    expect(sql).toBe([
      'SELECT x_k, true AS x_c,',
      '       CASE WHEN x_k THEN pg_advisory_unlock_shared((1297297987)::int4, (9)::int4) END AS u_k,',
      '       true AS u_c,',
      "       set_config('lock_timeout', '5000', true) AS lt,",
      "       set_config('application_name', 'ms2-coord:m07.cancel-round.approve', true) AS an",
      '  FROM (SELECT pg_try_advisory_xact_lock_shared((1297297987)::int4, (9)::int4) AS x_k OFFSET 0) s1',
    ].join('\n'))
    expect(sql).not.toContain('statement_timeout')
    assertSimpleProtocolSafe(sql)
  })

  it('sets no timeout for every other entry', () => {
    const sql = buildSettlementCoordinationS2Sql({ key2: 9, classZeroKey: C00, timeouts: { kind: 'none' }, entryLabel: 'm06.cancel-round.create' })
    expect(sql).not.toContain('statement_timeout')
    expect(sql).not.toContain('lock_timeout')
    expect(sql).toContain("set_config('application_name', 'ms2-coord:m06.cancel-round.create', true) AS an")
    assertSimpleProtocolSafe(sql)
  })

  it('rejects bad entry labels and bad timeout values', () => {
    for (const entryLabel of ['', 'Bad Label', 'x'.repeat(41), "a'b", 'a;b']) {
      expect(() => buildSettlementCoordinationS2Sql({ key2: 1, classZeroKey: null, timeouts: { kind: 'none' }, entryLabel }))
        .toThrow(AttendanceCoordinationKeyError)
    }
    for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildSettlementCoordinationS2Sql({
        key2: 1,
        classZeroKey: null,
        timeouts: { kind: 'lock-timeout-only', lockTimeoutMs },
        entryLabel: 'x',
      })).toThrow(AttendanceCoordinationKeyError)
    }
    expect(() => buildSettlementCoordinationS2Sql({
      key2: 1,
      classZeroKey: null,
      timeouts: { kind: 'other' } as unknown as { kind: 'none' },
      entryLabel: 'x',
    })).toThrow(AttendanceCoordinationKeyError)
  })
})

describe('settlement coordination session unlock', () => {
  it('releases exactly the held families, class-00 first', () => {
    expect(buildSettlementCoordinationSessionUnlockSql({ key2: 3, classZeroKey: null }))
      .toBe('SELECT pg_advisory_unlock_shared((1297297987)::int4, (3)::int4) AS u_k, true AS u_c')
    const both = buildSettlementCoordinationSessionUnlockSql({ key2: 3, classZeroKey: C00 })
    expect(both).toBe([
      'SELECT u_k, u_c',
      '  FROM (SELECT u_c, pg_advisory_unlock_shared((1297297987)::int4, (3)::int4) AS u_k',
      '          FROM (SELECT pg_advisory_unlock_shared((1234567890123)::bigint) AS u_c OFFSET 0) c',
      '        OFFSET 0) k',
    ].join('\n'))
    assertSimpleProtocolSafe(both)
  })
})
