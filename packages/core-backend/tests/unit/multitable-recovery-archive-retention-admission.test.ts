import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))

import { query as dbQuery, transaction as dbTransaction } from '../../src/db/pg'
import {
  startMetaRevisionRetention,
  sweepFieldValueTombstoneRetention,
  sweepLinkTombstoneRetention,
  type RetentionQueryFn,
} from '../../src/multitable/meta-revision-retention'

type Runner = <T>(work: (client: { query: RetentionQueryFn }) => Promise<T>) => Promise<T>
const config = { enabled: true, policy: 'keep-last-n' as const, keepN: 200, retentionDays: 30, batchSize: 2 }
const code = 'TOMBSTONE_RETENTION_ADMISSION_REFUSED'
const fieldSweep = sweepFieldValueTombstoneRetention
const linkSweep = sweepLinkTombstoneRetention

function selected() {
  vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
  vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
}

function harness(input: {
  groups?: unknown[]
  loose?: unknown[]
  state?: unknown
  stateRows?: unknown[]
  isolationRows?: unknown[]
  floorSchemaRows?: unknown[]
  changingXid?: boolean
  fail?: (sql: string) => unknown
} = {}) {
  const outside: Array<{ sql: string; params?: unknown[] }> = []
  const inside: Array<{ sql: string; params?: unknown[] }> = []
  const events: string[] = []
  let xid = 0
  const query: RetentionQueryFn = vi.fn(async (sql, params) => {
    outside.push({ sql, params })
    const error = input.fail?.(sql)
    if (error) throw error
    if (sql.includes('floor-schema')) return { rows: input.floorSchemaRows ?? [{ source_present: true, operation_present: true, table_present: true, floor_present: true }] }
    if (sql.includes('discover-groups')) return { rows: input.groups ?? [{ anchor: 'group-a', sheet_id: 'sheet-a' }] }
    if (sql.includes('discover-loose')) return { rows: input.loose ?? [{ id: 'loose-a', sheet_id: 'sheet-a' }] }
    return { rows: [], rowCount: 0 }
  })
  const txQuery: RetentionQueryFn = vi.fn(async (sql, params) => {
    inside.push({ sql, params }); events.push(sql)
    const error = input.fail?.(sql)
    if (error) throw error
    if (sql === 'SHOW transaction_isolation') return { rows: input.isolationRows ?? [{ transaction_isolation: 'read committed' }] }
    if (sql.includes('pg_current_xact_id()')) return { rows: [{ xid: input.changingXid ? String(++xid) : '42' }], rowCount: 1 }
    if (sql.startsWith('SELECT recovery_writer_state')) return { rows: input.stateRows ?? [{ recovery_writer_state: Object.hasOwn(input, 'state') ? input.state : null }] }
    if (sql.includes('fresh-groups')) return { rows: [], rowCount: 5 }
    if (sql.includes('fresh-loose')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const transaction: Runner = vi.fn(async (work) => {
    events.push('BEGIN')
    try { const result = await work({ query: txQuery }); events.push('COMMIT'); return result }
    catch (error) { events.push('ROLLBACK'); throw error }
  })
  return { query, txQuery, transaction, outside, inside, events }
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks() })

describe('G3 archive source tombstone retention admission', () => {
  test('selected injected query without an owned runner refuses before discovery or DELETE', async () => {
    selected()
    const h = harness()
    await expect(fieldSweep(h.query, config)).rejects.toMatchObject({ code, message: code })
    expect(h.outside).toEqual([])
  })

  test('disabled retention stays a zero-query no-op even when protection is selected', async () => {
    selected()
    const h = harness()
    expect(await fieldSweep(h.query, { ...config, enabled: false })).toBe(0)
    expect(h.outside).toEqual([])
  })

  test('every unselected literal combination preserves legacy SQL, parameters and order without invoking a runner', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', '')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
    const baseline = harness()
    await fieldSweep(baseline.query, config, baseline.transaction)
    await linkSweep(baseline.query, config, baseline.transaction)
    expect(baseline.outside).toHaveLength(4)
    for (const flags of [['', 'true'], ['true', ''], ['TRUE', 'true'], ['true ', 'true'], ['true', 'TRUE'], ['true', 'true '], ['1', 'true'], ['true', '1'], ['false', 'true']]) {
      vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', flags[0])
      vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', flags[1])
      const h = harness()
      await fieldSweep(h.query, config, h.transaction)
      await linkSweep(h.query, config, h.transaction)
      expect(h.outside, flags.join('/')).toEqual(baseline.outside)
      expect(h.transaction).not.toHaveBeenCalled()
    }
  })

  test.each([['field', fieldSweep], ['link', linkSweep]] as const)('%s uses one owned RC transaction, canonical fence, fresh state and exact eligibility', async (name, sweep) => {
    selected()
    const h = harness()
    expect(await sweep(h.query, config, h.transaction)).toBe(6)
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.outside.map((call) => call.params)).toEqual(name === 'link' ? [undefined, [30, 2], [30, 2]] : [[30, 2], [30, 2]])
    expect(h.outside.every((call) => !call.sql.includes('DELETE'))).toBe(true)
    const sql = h.inside.map((call) => call.sql)
    expect(sql.slice(0, 4)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation', 'SELECT pg_current_xact_id()::text AS xid', 'SELECT pg_current_xact_id()::text AS xid'])
    expect(sql[4]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))')
    expect(h.inside[4].params).toEqual(['meta:auto-number:sheet:sheet-a'])
    expect(sql[5]).toBe('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1')
    const grouped = h.inside.find((call) => call.sql.includes('fresh-groups'))!
    expect(grouped.params).toEqual([30, 'sheet-a', ['group-a']])
    expect(grouped.sql).toContain('bool_and(operation_id IS NULL)')
    expect(grouped.sql).toContain('count(DISTINCT sheet_id) = 1')
    expect(grouped.sql).toContain('min(sheet_id) = $2')
    expect(grouped.sql).toContain('max(created_at) AS newest')
    expect(grouped.sql).not.toContain('GROUP BY sheet_id')
    expect(grouped.sql).not.toContain('LIMIT')
    const loose = h.inside.find((call) => call.sql.includes('fresh-loose'))!
    expect(loose.params).toEqual([30, 'sheet-a', ['loose-a']])
    expect(loose.sql).toContain('sheet_id = $2')
    expect(loose.sql).toContain('operation_id IS NULL')
    expect(loose.sql).toContain('IS NULL')
    expect(loose.sql).toContain('id = ANY($3::uuid[])')
    expect(h.events.at(-1)).toBe('COMMIT')
  })

  test('one global group budget and separate loose-row budget route two sheets without a per-sheet LIMIT reset', async () => {
    selected()
    const h = harness({ groups: [{ anchor: 'a', sheet_id: 'sheet-a' }, { anchor: 'b', sheet_id: 'sheet-b' }], loose: [{ id: 'c', sheet_id: 'sheet-a' }, { id: 'd', sheet_id: 'sheet-b' }] })
    expect(await fieldSweep(h.query, config, h.transaction)).toBe(12)
    expect(h.outside).toHaveLength(2)
    expect(h.outside.every((call) => call.sql.includes('LIMIT $2'))).toBe(true)
    expect(h.transaction).toHaveBeenCalledTimes(2)
    expect(h.inside.filter((call) => call.sql.includes('fresh-groups')).map((call) => call.params)).toEqual([[30, 'sheet-a', ['a']], [30, 'sheet-b', ['b']]])
    expect(h.inside.filter((call) => call.sql.includes('fresh-loose')).every((call) => !call.sql.includes('LIMIT'))).toBe(true)
  })

  test('empty bounded discoveries start no transaction', async () => {
    selected()
    const h = harness({ groups: [], loose: [] })
    expect(await fieldSweep(h.query, config, h.transaction)).toBe(0)
    expect(h.transaction).not.toHaveBeenCalled()
  })

  test.each(['fencing', 'applying', 'paused_retryable', 'archiving'])('durable %s skips the entire sheet including loose candidates', async (state) => {
    selected()
    const h = harness({ state })
    expect(await fieldSweep(h.query, config, h.transaction)).toBe(0)
    expect(h.inside.some((call) => call.sql.includes('DELETE'))).toBe(false)
    expect(h.events.at(-1)).toBe('COMMIT')
  })

  test.each([{ state: 'unknown-sensitive' }, { state: undefined }, { stateRows: [] }, { stateRows: [{ recovery_writer_state: null }, { recovery_writer_state: null }] }])('missing or unknown durable state refuses closed and values-free: %j', async (input) => {
    selected()
    const h = harness(input)
    await expect(fieldSweep(h.query, config, h.transaction)).rejects.toMatchObject({ code, message: code })
    expect(h.inside.some((call) => call.sql.includes('DELETE'))).toBe(false)
    expect(h.events.at(-1)).toBe('ROLLBACK')
  })

  test.each([{ isolationRows: [] }, { isolationRows: [{ transaction_isolation: 'repeatable read' }] }, { isolationRows: [{ transaction_isolation: 'read committed' }, { transaction_isolation: 'read committed' }] }])('isolation cannot be verified: %j', async ({ isolationRows }) => {
    selected()
    const h = harness({ isolationRows })
    await expect(fieldSweep(h.query, config, h.transaction)).rejects.toMatchObject({ code })
    expect(h.inside.some((call) => call.sql.includes('pg_advisory') || call.sql.includes('DELETE'))).toBe(false)
  })

  test('autocommit or forged runner with changing native xids refuses before fence or DELETE', async () => {
    selected()
    const h = harness({ changingXid: true })
    await expect(fieldSweep(h.query, config, h.transaction)).rejects.toMatchObject({ code, message: code })
    expect(h.inside.some((call) => call.sql.includes('pg_advisory') || call.sql.includes('DELETE'))).toBe(false)
  })

  test.each(['SET TRANSACTION', 'SELECT recovery_writer_state', 'fresh-groups'])('database failure at %s escapes only as a fixed values-free code', async (point) => {
    selected()
    const h = harness({ fail: (sql) => sql.includes(point) ? new Error('sensitive SQL details and user value') : undefined })
    const error = await fieldSweep(h.query, config, h.transaction).catch((error: unknown) => error)
    expect(error).toMatchObject({ code, message: code })
    expect(JSON.stringify(error)).not.toContain('sensitive')
    expect(h.events.at(-1)).toBe('ROLLBACK')
  })

  test.each(['operation_id', 'meta_field_value_tombstones'])('missing %s retains zero-delete deployment behavior', async (identifier) => {
    selected()
    const h = harness({ fail: (sql) => sql.includes('discover-groups') ? Object.assign(new Error(identifier), { code: identifier === 'operation_id' ? '42703' : '42P01' }) : undefined })
    expect(await fieldSweep(h.query, config, h.transaction)).toBe(0)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.outside.some((call) => call.sql.includes('DELETE'))).toBe(false)
  })

  test('link floor 42703 rolls back its savepoint before guarded fallback and loose deletion', async () => {
    selected()
    const h = harness({ fail: (sql) => sql.includes('fresh-groups') && sql.includes('delete_revision_id') ? Object.assign(new Error('delete_revision_id'), { code: '42703' }) : undefined })
    expect(await linkSweep(h.query, config, h.transaction)).toBe(6)
    const sql = h.inside.map((call) => call.sql)
    const rollback = sql.indexOf('ROLLBACK TO SAVEPOINT retention_admission_floor')
    expect(rollback).toBeGreaterThan(sql.indexOf('SAVEPOINT retention_admission_floor'))
    const fallback = h.inside[rollback + 1]
    expect(fallback.sql).toContain('fresh-groups')
    expect(fallback.sql).not.toContain('delete_revision_id')
    expect(fallback.sql).toContain('bool_and(operation_id IS NULL)')
    expect(fallback.sql).toContain('count(DISTINCT sheet_id) = 1')
    expect(sql[rollback + 2]).toBe('RELEASE SAVEPOINT retention_admission_floor')
    expect(sql[rollback + 3]).toContain('fresh-loose')
  })

  test('initial link routing excludes immortal floor groups before its single global LIMIT, then rechecks the floor under the fence', async () => {
    selected()
    const h = harness()
    await linkSweep(h.query, { ...config, batchSize: 1 }, h.transaction)
    const discovery = h.outside.find((call) => call.sql.includes('discover-groups'))!
    expect(discovery.params).toEqual([30, 1])
    expect(discovery.sql.indexOf('delete_revision_id')).toBeLessThan(discovery.sql.indexOf('LIMIT $2'))
    expect(h.inside.find((call) => call.sql.includes('fresh-groups'))!.sql).toContain('delete_revision_id')
  })

  test('a real missing-floor metadata result selects only floorless initial routing and retains guarded native fallback', async () => {
    selected()
    const h = harness({ floorSchemaRows: [{ source_present: true, operation_present: true, table_present: true, floor_present: false }], fail: (sql) => sql.includes('fresh-groups') && sql.includes('delete_revision_id') ? Object.assign(new Error('delete_revision_id'), { code: '42703' }) : undefined })
    expect(await linkSweep(h.query, config, h.transaction)).toBe(6)
    expect(h.outside.find((call) => call.sql.includes('discover-groups'))!.sql).not.toContain('delete_revision_id')
    expect(h.inside.some((call) => call.sql === 'ROLLBACK TO SAVEPOINT retention_admission_floor')).toBe(true)
  })

  test('missing trash schema refuses initial routing without deleting', async () => {
    selected()
    const h = harness({ floorSchemaRows: [{ source_present: true, operation_present: true, table_present: false, floor_present: false }] })
    await expect(linkSweep(h.query, config, h.transaction)).rejects.toMatchObject({ code })
    expect(h.transaction).not.toHaveBeenCalled()
  })

  test.each([{ source_present: false, operation_present: false }, { source_present: true, operation_present: false }])('missing link tombstone deployment schema stays zero-delete even without trash: %j', async (schema) => {
    selected()
    const h = harness({ floorSchemaRows: [{ ...schema, table_present: false, floor_present: false }] })
    expect(await linkSweep(h.query, config, h.transaction)).toBe(0)
    expect(h.outside).toHaveLength(1)
    expect(h.transaction).not.toHaveBeenCalled()
  })

  test('an unrelated missing-column error cannot select floorless fallback', async () => {
    selected()
    const h = harness({ fail: (sql) => sql.includes('fresh-groups') ? Object.assign(new Error('other_sensitive_column'), { code: '42703' }) : undefined })
    await expect(linkSweep(h.query, config, h.transaction)).rejects.toMatchObject({ code })
    expect(h.inside.filter((call) => call.sql.includes('fresh-groups'))).toHaveLength(1)
    expect(h.inside.some((call) => call.sql.includes('fresh-loose'))).toBe(false)
  })

  test('scheduler injected query cannot acquire a default transaction from a different database', async () => {
    selected(); vi.useFakeTimers()
    const h = harness()
    const warn = vi.fn()
    const stop = startMetaRevisionRetention({ query: h.query, env: { MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' }, intervalMs: 1000, logger: { info() {}, warn } as never })
    await vi.advanceTimersByTimeAsync(1000); stop()
    expect(h.outside).toHaveLength(2)
    expect(h.outside.every((call) => !call.sql.includes('tombstones'))).toBe(true)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.every((call) => call[1].code === code)).toBe(true)
  })

  test('scheduler default database query uses the existing native transaction adapter for both protected sweeps', async () => {
    selected(); vi.useFakeTimers()
    const h = harness()
    vi.mocked(dbQuery).mockImplementation(h.query as typeof dbQuery)
    vi.mocked(dbTransaction).mockImplementation(h.transaction as typeof dbTransaction)
    const warn = vi.fn()
    const stop = startMetaRevisionRetention({ env: { MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' }, intervalMs: 1000, logger: { info() {}, warn } as never })
    await vi.advanceTimersByTimeAsync(1000); stop()
    expect(dbTransaction).toHaveBeenCalledTimes(2)
    expect(h.inside.filter((call) => call.sql.includes('fresh-groups'))).toHaveLength(2)
    expect(warn).not.toHaveBeenCalled()
  })
})
