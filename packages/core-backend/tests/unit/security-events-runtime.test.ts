import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { EventConnections, W1Capacity, type EventClient, type EventSql, type W1Transaction } from '../../src/security-events/runtime'
import { randomUUID } from 'node:crypto'
import { validateEvent, type EventCandidate } from '../../src/security-events/validation'
import { SecurityEventRepository } from '../../src/security-events/repository'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_RUNTIME=' + assertionCount) })
function mockClient() {
  const trace: { text: string; values?: unknown[] }[] = []
  const client: EventClient = {
    connect: vi.fn(async () => {}), end: vi.fn(async () => {}), on: vi.fn(),
    query: vi.fn(async <R>(text: string, values?: unknown[]) => { trace.push({ text, values }); return { rows: [] as R[] } }) as EventSql['query'],
  }
  return { client, trace }
}
function transaction() {
  const completed = deferred(), mock = mockClient()
  mock.client.query = vi.fn(async <R>(text: string, values?: unknown[]) => {
    mock.trace.push({ text, values })
    return { rows: (text.includes('current_setting') ? [{ lock_timeout: '5ms', statement_timeout: '25ms' }] : []) as R[] }
  }) as EventSql['query']
  const tx: W1Transaction = { sql: mock.client, settledAndReleased: completed.promise, deadline: performance.now() + 5000, destroy: vi.fn(async () => {}) }
  return { tx, completed, ...mock }
}

describe('E1-A isolated capacity and server-side budgets', () => {
  it('T20 passive construction creates no clients, timers or cleanup work', async () => {
    const factory = vi.fn(() => mockClient().client)
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, factory)
    const repo = new SecurityEventRepository(connections, new W1Capacity(20))
    expect(await repo.cleanup(false)).toEqual({ enabled: false, deliveries: 0, events: 0, activeExpired: false })
    expect(factory).not.toHaveBeenCalled()
  })
  it('T20/P3-q write 3 saturation preserves reserved query 1 and returns a distinct retryable busy code', async () => {
    const hold = deferred(), clients: EventClient[] = [], configs: unknown[] = []
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, config => { configs.push(config); const c = mockClient().client; clients.push(c); return c })
    const pending = [1, 2, 3].map(() => connections.writeTransaction('background', () => hold.promise))
    await tick()
    expect(connections.active.write).toBe(3)
    await expect(connections.writeTransaction('foreground', async () => 1)).rejects.toMatchObject({ code: 'E1_WRITE_UNAVAILABLE' })
    const read = connections.readTransaction(performance.now(), () => hold.promise)
    await tick()
    await expect(connections.readTransaction(performance.now(), async () => 1)).rejects.toMatchObject({ code: 'E1_QUERY_BUSY', retryable: true })
    expect(connections.active).toEqual({ write: 3, query: 1 })
    expect(configs).toHaveLength(4)
    expect(JSON.stringify(configs)).toContain('default_transaction_read_only=on')
    for (const config of configs) expect(config).toMatchObject({ options: expect.stringContaining('-c lock_timeout=100ms -c statement_timeout=100ms') })
    hold.resolve(); await Promise.all([...pending, read]); await tick()
    expect(connections.active).toEqual({ write: 0, query: 0 })
    expect(clients[3].query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  })
  it('T43 background work retains the total two-second deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const hold = deferred(), rejected = vi.fn()
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => mockClient().client)
    const pending = connections.writeTransaction('background', () => hold.promise).catch(rejected)
    try {
      await vi.advanceTimersByTimeAsync(1999)
      expect(rejected).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'E1_WRITE_UNAVAILABLE' }))
    } finally { hold.resolve(); await pending; vi.useRealTimers() }
  })
  it('T20 missing configuration and initialization errors cannot borrow a main pool', async () => {
    expect(() => new EventConnections({})).toThrow('E1_WRITE_UNAVAILABLE')
    expect(() => new EventConnections({ connectionString: 'postgres://fixture/fixture?options=-c%20statement_timeout=0' })).toThrow('E1_WRITE_UNAVAILABLE')
    const factory = vi.fn(() => { throw new Error('private connection detail') })
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, factory)
    await expect(connections.writeTransaction('foreground', async () => 1)).rejects.toThrow('E1_WRITE_UNAVAILABLE')
    await expect(connections.readTransaction(performance.now(), async () => 1)).rejects.toThrow('E1_QUERY_UNAVAILABLE')
    expect(connections.active).toEqual({ write: 0, query: 0 })
  })
  it('T42 deadline closes a client but does not release capacity before confirmed termination or start late SQL', async () => {
    const connect = deferred(), closed = deferred(), work = vi.fn()
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => ({ ...mockClient().client, connect: () => connect.promise, end: () => closed.promise }))
    await expect(connections.writeTransaction('foreground', work)).rejects.toThrow('E1_WRITE_UNAVAILABLE')
    expect(connections.active.write).toBe(1)
    connect.resolve(); await tick(); expect(work).not.toHaveBeenCalled()
    expect(connections.active.write).toBe(1)
    closed.resolve(); await tick(); expect(connections.active.write).toBe(0)
  })
  it('T43 bounds each SQL and COMMIT on the server, and includes prior request elapsed time', async () => {
    const { client, trace } = mockClient()
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => client)
    await connections.writeTransaction('foreground', async sql => { await sql.query('SELECT 1'); await sql.query('SELECT 2') })
    expect(trace.map(x => x.text)).toEqual(['BEGIN', expect.stringContaining('set_config'), 'SELECT 1', expect.stringContaining('set_config'), 'SELECT 2', expect.stringContaining('set_config'), 'COMMIT'])
    for (const row of trace.filter(x => x.values)) expect(parseInt(row.values![0] as string)).toBeLessThanOrEqual(100)
    await expect(connections.readTransaction(performance.now() - 5001, async () => 1)).rejects.toThrow('E1_QUERY_UNAVAILABLE')
  })
  it('T08 normalizes SQLSTATE, message and cause at the W1 and committed boundaries', async () => {
    const { client } = mockClient()
    client.query = vi.fn(async () => { throw Object.assign(new Error('relation private_secret does not exist'), { code: '42P01', cause: 'private_secret' }) })
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => client)
    const repo = new SecurityEventRepository(connections, new W1Capacity(20))
    expect(await repo.appendCommitted({} as never, {} as never)).toEqual({ recorded: false, code: 'E1_WRITE_UNAVAILABLE', count_unknown: true })
    const { tx } = transaction()
    try { await repo.appendW1({ ...tx, sql: client }, {} as never, {} as never); expect.fail() }
    catch (error) { expect(error).toMatchObject({ code: 'E1_WRITE_UNAVAILABLE', message: 'E1_WRITE_UNAVAILABLE' }); expect(error).not.toHaveProperty('cause') }
  })
})

describe('E1-A a successful run releases its slot before returning; uncertain closes keep it', () => {
  const later = () => new Promise<void>(resolve => setTimeout(resolve, 5))
  it('T20 a second read and write in the same flow are admitted after the first returns', async () => {
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => ({ ...mockClient().client, end: later }))
    expect(await connections.readTransaction(performance.now(), async () => 'first')).toBe('first')
    expect(connections.active.query).toBe(0)
    expect(await connections.readTransaction(performance.now(), async () => 'second')).toBe('second')
    expect(connections.active.query).toBe(0)
    expect(await connections.writeTransaction('foreground', async () => 'write')).toBe('write')
    expect(connections.active.write).toBe(0)
  })
  it('T42 a timed-out read rejects without waiting for close and keeps its slot until termination is confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const hold = deferred(), closed = deferred(), rejected = vi.fn()
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => ({ ...mockClient().client, end: () => closed.promise }))
    const pending = connections.readTransaction(performance.now(), () => hold.promise).catch(rejected)
    try {
      await vi.advanceTimersByTimeAsync(2000)
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'E1_QUERY_UNAVAILABLE' }))
      expect(connections.active.query).toBe(1)
      await expect(connections.readTransaction(performance.now(), async () => 1)).rejects.toMatchObject({ code: 'E1_QUERY_BUSY' })
      closed.resolve(); await vi.advanceTimersByTimeAsync(0)
      expect(connections.active.query).toBe(0)
    } finally { hold.resolve(); closed.resolve(); await pending; vi.useRealTimers() }
  })
  it('T42 a rejected close quarantines the read slot permanently even after a successful read', async () => {
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => ({ ...mockClient().client, end: () => Promise.reject(new Error('private close detail')) }))
    expect(await connections.readTransaction(performance.now(), async () => 'done')).toBe('done')
    await later(); await tick()
    expect(connections.active.query).toBe(1)
    await expect(connections.readTransaction(performance.now(), async () => 1)).rejects.toMatchObject({ code: 'E1_QUERY_BUSY', retryable: true })
    expect(connections.active.query).toBe(1)
  })
  it('T43 a hung close bounds the wait within the run budget and keeps the slot occupied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const resolved = vi.fn()
    const connections = new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => ({ ...mockClient().client, end: () => new Promise<void>(() => {}) }))
    try {
      const read = connections.readTransaction(performance.now(), async () => 'read').then(resolved)
      await vi.advanceTimersByTimeAsync(99)
      expect(resolved).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(resolved).toHaveBeenCalledWith('read')
      await read
      expect(connections.active.query).toBe(1)
      await expect(connections.readTransaction(performance.now(), async () => 1)).rejects.toMatchObject({ code: 'E1_QUERY_BUSY' })
      // A foreground write that used most of its 100ms budget waits only for what is left of it.
      const started = performance.now()
      const write = connections.writeTransaction('foreground', () => new Promise(resolve => setTimeout(resolve, 90))).then(resolved)
      await vi.advanceTimersByTimeAsync(100)
      await write
      expect(performance.now() - started).toBeLessThanOrEqual(100)
      expect(resolved).toHaveBeenCalledTimes(2)
      expect(connections.active.write).toBe(1)
    } finally { vi.useRealTimers() }
  })
})

describe('E1-A W1 admission follows the outer transaction lifecycle', () => {
  it('T43 holds through append/savepoint boundaries, shares proof-user capacity and rejects only at E1 entry', async () => {
    const capacity = new W1Capacity(20)
    const a = transaction(), b = transaction(), c = transaction()
    expect(capacity.active).toBe(0)
    await capacity.run(a.tx, async sql => { await sql.query('SELECT 1') }, 'user-A')
    expect(capacity.active).toBe(1)
    await capacity.run(a.tx, async () => {}, 'user-A')
    expect(capacity.active).toBe(1)
    await expect(capacity.run(b.tx, async () => {}, 'user-A')).rejects.toThrow()
    await capacity.run(c.tx, async () => {}, 'user-B')
    expect(capacity.active).toBe(2)
    a.completed.resolve(); c.completed.resolve(); await tick()
    expect(capacity.active).toBe(0)
    await expect(capacity.run(a.tx, async () => {}, 'user-A')).rejects.toThrow()
  })
  it('T43 main pool <5 admits no W1; no business/proof-compare work is pre-admitted', async () => {
    const capacity = new W1Capacity(4), { tx } = transaction(), work = vi.fn()
    expect(capacity.active).toBe(0)
    await expect(capacity.run(tx, work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })
  it('T43 restores shorter original timeouts only on success; an aborted savepoint keeps its outer slot', async () => {
    const capacity = new W1Capacity(20), a = transaction()
    await capacity.run(a.tx, sql => sql.query('SELECT 1'))
    const settings = a.trace.filter(x => x.text.includes('set_config'))
    expect(settings[0].values).toEqual(['5ms', '25ms'])
    expect(settings.at(-1)!.values).toEqual(['5ms', '25ms'])
    const count = a.trace.length
    await expect(capacity.run(a.tx, async () => { throw new Error('private') })).rejects.toThrow('E1_WRITE_UNAVAILABLE')
    expect(a.trace.slice(count).filter(x => x.text.includes('set_config'))).toHaveLength(0)
    expect(capacity.active).toBe(1)
    a.completed.resolve(); await tick(); expect(capacity.active).toBe(0)
  })
  it('T43 unknown outer outcome and timed-out work cannot prematurely release or reuse a client', async () => {
    const capacity = new W1Capacity(20), a = transaction(), hold = deferred()
    const tx = { ...a.tx, deadline: performance.now() + 20 }
    await expect(capacity.run(tx, () => hold.promise)).rejects.toThrow()
    expect(tx.destroy).toHaveBeenCalledOnce()
    expect(capacity.active).toBe(1)
    await expect(capacity.run(tx, async () => {})).rejects.toThrow()
    hold.resolve(); await tick()
    a.completed.resolve(); await tick(); expect(capacity.active).toBe(0)
  })
})

it('T26 cleanup enforces a total 1000-row batch and reports expired active work without deleting its parent', async () => {
  const { client, trace } = mockClient()
  client.query = (async <R>(text: string, values?: unknown[]) => {
    trace.push({ text, values })
    return { rows: (text.includes('SELECT EXISTS') ? [{ present: true }] : text.includes('DELETE FROM public.security_event_deliveries') ? Array.from({ length: 1000 }, (_, id) => ({ id })) : []) as R[] }
  }) as EventSql['query']
  const repo = new SecurityEventRepository(new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => client), new W1Capacity(20))
  const result = await repo.cleanup(true, 1000)
  expect(result).toEqual({ enabled: true, deliveries: 1000, events: 0, activeExpired: true, diagnostic: 'active_delivery_expired' })
  expect(trace.some(item => item.text.includes('DELETE FROM public.security_events '))).toBe(false)
  expect(trace.find(item => item.text.includes('DELETE FROM public.security_event_deliveries'))?.values).toEqual([1000])
  await expect(repo.cleanup(true, 1001)).rejects.toThrow('E1_WRITE_UNAVAILABLE')
})

it('T04 committed identity conflicts retain diagnostics through the isolated pool', async () => {
  const input: EventCandidate = { id: randomUUID(), producer: 'auth', event_type: 'auth.session_registered', source_kind: 'auth_operation', source_id: randomUUID(), source_step: 'password', actor_kind: 'system', actor_user_id: null, subject_user_id: null, target_kind: null, target_id: null, reason_code: null, record_origin: 'live', occurred_at: '2026-11-22T00:00:00Z', facts: {} }
  const row = validateEvent(input, { kind: 'session', orgId: 'B' })
  const { client } = mockClient()
  client.query = vi.fn(async (text: string) => ({ rows: text.includes('FROM public.security_events') ? [row] : [] })) as EventSql['query']
  const repo = new SecurityEventRepository(new EventConnections({ connectionString: 'postgres://fixture/fixture' }, () => client), new W1Capacity(20))
  expect(await repo.appendCommitted(input, { kind: 'session', orgId: 'A' })).toEqual({ recorded: false, code: 'E1_WRITE_UNAVAILABLE', count_unknown: true, diagnostic: 'event_identity_conflict' })
})
