/** Synthetic query sequencing only. Actual renewal/SHARE contention is proved in owned PG tests. */
import { describe, expect, it, vi } from 'vitest'
import { AutomationReadProfileError, lockAutomationReadProducerForRead, lockAutomationReadProfile,
  renewAutomationReadProducer } from '../../../src/integration/automation-read-profiles'

const producer = { generation: '1', nonce: '11111111-1111-4111-8111-111111111111' }
const revision = '22222222-2222-4222-8222-222222222222'
const scope = { tenantId: 'synthetic-tenant', targetId: producer.nonce }
function fixture(previous = '0', timeout: string | number = '0') {
  const state = { locked: [{ ...producer }], fresh: [{ ...producer, live: true }], settings: [{ previous, timeout_ms: timeout }] }
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (sql.includes('transaction_isolation')) return { rows: [{ isolation: 'read committed' }], rowCount: null }
    if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '101' }], rowCount: null }
    if (sql.includes("current_setting('lock_timeout')")) return { rows: state.settings, rowCount: null }
    if (sql.includes("set_config('lock_timeout'")) return { rows: [], rowCount: null }
    if (sql.includes('FROM automation_read_producer_slot')) {
      if (sql.includes('FOR SHARE')) return { rows: state.locked, rowCount: null }
      if (sql.includes('FOR UPDATE NOWAIT')) return { rows: state.fresh, rowCount: null }
      return { rows: state.fresh, rowCount: null }
    }
    if (sql.includes('SELECT p.target_id::text')) return { rows: [{ target_id: scope.targetId, tenant_id: scope.tenantId,
      sheet_id: 'synthetic-sheet', action_id: 'synthetic-action', project_id: 'synthetic-project', object_id: 'synthetic-object',
      material: {}, revision, producer_generation: producer.generation, producer_nonce: producer.nonce,
      enabled: true, binding_tenant_id: scope.tenantId }], rowCount: null }
    if (sql.includes('SET expires_at=clock_timestamp()')) return { rows: [{ ...producer }], rowCount: null }
    throw new Error('Unexpected synthetic query')
  })
  return { state, calls, query, trx: { query, isTransaction: true as const } }
}
function settings(f: ReturnType<typeof fixture>) { return f.calls.filter(call => call.sql.includes("set_config('lock_timeout'")) }

describe('producer read fence bounded SHARE wait', () => {
  it.each([['0', '0'], ['1s', '1000'], ['1min', '60000']])('caps %s per-lock waiting and restores its exact original setting', async (previous, timeout) => {
    const f = fixture(previous, timeout)
    await lockAutomationReadProducerForRead(f.trx, producer)
    expect(settings(f).map(call => call.params)).toEqual([['250ms'], [previous]])
    const lock = f.calls.findIndex(call => call.sql.includes('FOR SHARE'))
    const restore = f.calls.findIndex(call => call.params?.[0] === previous)
    const fresh = f.calls.findIndex(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))
    expect(lock).toBeGreaterThan(0); expect(restore).toBeGreaterThan(lock); expect(fresh).toBeGreaterThan(restore)
    expect(f.calls[lock].sql).not.toContain('NOWAIT')
    expect(f.calls[lock].sql).not.toContain('KEY SHARE')
    expect(f.calls[lock].sql).not.toContain('clock_timestamp')
  })
  it.each([['1ms', '1'], ['100ms', '100'], ['250ms', '250']])('never lengthens caller timeout %s', async (previous, timeout) => {
    const f = fixture(previous, timeout)
    await lockAutomationReadProducerForRead(f.trx, producer)
    expect(settings(f)).toEqual([])
    expect(f.calls.filter(call => call.sql.includes('FOR SHARE'))).toHaveLength(1)
  })
  it.each(['expired', 'generation', 'nonce', 'missing'] as const)('rejects post-acquisition %s on a fresh DB-clock read', async changed => {
    const f = fixture()
    if (changed === 'expired') f.state.fresh[0].live = false
    if (changed === 'generation') f.state.fresh[0].generation = '2'
    if (changed === 'nonce') f.state.fresh[0].nonce = revision
    if (changed === 'missing') f.state.fresh = []
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_FENCE_LOST' })
    expect(settings(f).map(call => call.params)).toEqual([['250ms'], ['0']])
    expect(f.calls.filter(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toHaveLength(1)
  })
  it.each(['missing', 'generation', 'nonce'] as const)('requires the original locked row, not a later unlocked %s replacement', async changed => {
    const f = fixture()
    if (changed === 'missing') f.state.locked = []
    if (changed === 'generation') f.state.locked[0].generation = '2'
    if (changed === 'nonce') f.state.locked[0].nonce = revision
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_FENCE_LOST' })
    expect(settings(f).map(call => call.params)).toEqual([['250ms'], ['0']])
    expect(f.calls.some(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toBe(false)
  })
  it.each(['55P03', 'XX000'])('does not retry or restore after acquisition SQL failure %s', async code => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FOR SHARE')) { f.calls.push({ sql, params }); throw { code, message: 'private SQL cause' } }
      return actual(sql, params)
    })
    const error = await lockAutomationReadProducerForRead(f.trx, producer).catch(error => error)
    expect(error).toBeInstanceOf(AutomationReadProfileError)
    expect(error.code).toBe('AUTOMATION_PROFILE_UNAVAILABLE')
    expect(error.cause).toBeUndefined(); expect(String(error)).not.toContain('private')
    expect(settings(f).map(call => call.params)).toEqual([['250ms']])
    expect(f.calls.filter(call => call.sql.includes('FOR SHARE'))).toHaveLength(1)
    expect(f.calls.some(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toBe(false)
  })
  it('does not restore over an original typed acquisition failure', async () => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    const original = new AutomationReadProfileError('AUTOMATION_PROFILE_FENCE_LOST')
    f.query.mockImplementation(async (sql, params) => { if (sql.includes('FOR SHARE')) throw original; return actual(sql, params) })
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toBe(original)
    expect(settings(f).map(call => call.params)).toEqual([['250ms']])
  })
  it('fails closed if exact timeout restoration fails', async () => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes("set_config('lock_timeout'") && params?.[0] === '0') throw new Error('private restore cause')
      return actual(sql, params)
    })
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_UNAVAILABLE' })
    expect(f.calls.some(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toBe(false)
  })
  it.each(['', 'not-ms', '-1', '1.5', Number.NaN, Number.POSITIVE_INFINITY])('rejects malformed normalized timeout %s before touching the slot', async timeout => {
    const f = fixture('0', timeout)
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_UNAVAILABLE' })
    expect(settings(f)).toEqual([])
    expect(f.calls.some(call => call.sql.includes('FROM automation_read_producer_slot'))).toBe(false)
  })
  it('requires exactly one genuine timeout setting receipt before changing a GUC', async () => {
    const f = fixture(); f.state.settings = []
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_UNAVAILABLE' })
    expect(settings(f)).toEqual([])
    expect(f.calls.some(call => call.sql.includes('FROM automation_read_producer_slot'))).toBe(false)
  })
  it('rejects a missing exact original timeout string rather than inventing a restore value', async () => {
    const f = fixture('', '0')
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_UNAVAILABLE' })
    expect(settings(f)).toEqual([])
  })
  it('does not touch timeout settings or locks when genuine transaction admission fails', async () => {
    const f = fixture(), actual = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes('transaction_isolation')) return { rows: [{ isolation: 'repeatable read' }], rowCount: null }
      return actual(sql, params)
    })
    await expect(lockAutomationReadProducerForRead(f.trx, producer)).rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_TRANSACTION_REQUIRED' })
    expect(f.calls).toEqual([])
  })
  it('retains both profile fences and the independent profile/binding NOWAIT lock', async () => {
    const f = fixture()
    await expect(lockAutomationReadProfile(f.trx, producer, scope)).resolves.toMatchObject({ producer, revision })
    expect(f.calls.filter(call => call.sql.includes('WHERE slot_id = 1 FOR SHARE'))).toHaveLength(2)
    expect(f.calls.filter(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toHaveLength(2)
    expect(f.calls.find(call => call.sql.includes('SELECT p.target_id::text'))?.sql).toContain('FOR SHARE OF p,b NOWAIT')
  })
  it('renewal still locks UPDATE NOWAIT and never enters the reader timeout helper', async () => {
    const f = fixture()
    await expect(renewAutomationReadProducer(f.trx, producer)).resolves.toBeUndefined()
    expect(f.calls.find(call => call.sql.includes('FROM automation_read_producer_slot'))?.sql).toContain('FOR UPDATE NOWAIT')
    expect(settings(f)).toEqual([])
    expect(f.calls.some(call => call.sql.includes("current_setting('lock_timeout')"))).toBe(false)
  })
})
