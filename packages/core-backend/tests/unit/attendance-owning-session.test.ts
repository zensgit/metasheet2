import { Duplex } from 'node:stream'
import { Client, Query } from 'pg'
import type { PoolClient } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttendanceManagedPgClient,
  AttendanceManagedPgPool,
  assertAttendanceLeaseIsIdleV1,
  attendanceOwningSessionForClientV1,
  withAttendanceExclusiveIdleSessionV1,
} from '../../src/attendance/attendance-owning-session'
import { AttendanceReleaseObservedPool } from '../helpers/attendance-w4-release-probe'
import type {
  AttendanceOwningSessionV1,
  AttendanceSessionLeaseV1,
} from '../../src/attendance/attendance-owning-session'

// Real pg Client/Pool/Query/parser, synthetic wire only. No database, pg mock,
// trusted flag, status setter, exported test issuer, or production test seam.
function frame(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type)
  header.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([header, payload])
}

class Wire extends Duplex {
  readonly sql: string[] = []
  private startup = true

  _read(): void {}
  setNoDelay(): void {}
  setKeepAlive(): void {}
  ref(): void {}
  unref(): void {}
  connect(): void { queueMicrotask(() => this.emit('connect')) }

  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.startup) {
      this.startup = false
      queueMicrotask(() => {
        const backend = Buffer.alloc(8)
        backend.writeInt32BE(123, 0)
        backend.writeInt32BE(456, 4) // synthetic protocol fixture, never a live key
        this.push(Buffer.concat([
          frame('R', Buffer.alloc(4)),
          frame('K', backend),
          frame('Z', Buffer.from('I')),
        ]))
      })
    } else if (chunk[0] === 'Q'.charCodeAt(0)) {
      this.sql.push(chunk.subarray(5, chunk.length - 1).toString())
    }
    done()
  }

  _final(done: (error?: Error | null) => void): void {
    done()
    this.destroy()
  }

  ready(status: string): void { this.push(frame('Z', Buffer.from(status))) }
  complete(command = 'SELECT 0', status = 'I'): void {
    this.push(Buffer.concat([frame('C', Buffer.from(command + '\0')), frame('Z', Buffer.from(status))]))
  }
  fail(code = '22012'): void {
    this.push(frame('E', Buffer.from('SERROR\0C' + code + '\0Msynthetic query failure\0\0')))
  }
  notice(): void { this.push(frame('N', Buffer.from('SNOTICE\0Msynthetic notice\0\0'))) }
}

const pools: AttendanceManagedPgPool[] = []
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const refusal = { code: 'W4C0_CONNECTION_NOT_IDLE' }
type Endable = PoolClient & { end(): Promise<void> }

function fixture(PoolType: typeof AttendanceManagedPgPool = AttendanceManagedPgPool) {
  const wires: Wire[] = []
  const pool = new PoolType({
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 0,
    ssl: false,
    user: 'synthetic',
    password: 'synthetic',
    database: 'synthetic',
    host: 'unused.invalid',
    stream: () => {
      const wire = new Wire()
      wires.push(wire)
      return wire
    },
  })
  pool.on('error', () => undefined)
  pools.push(pool)
  const connect = async () => {
    const client = await pool.connect()
    client.on('error', () => undefined)
    return client
  }
  return { pool, wires, connect }
}

async function command(client: PoolClient, wire: Wire, text: string, status: string): Promise<void> {
  const pending = client.query(text)
  wire.complete(text, status)
  await pending
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const pool of pools.splice(0)) {
    // Teardown may inspect pg internals; application admission never does this.
    const clients = (pool as unknown as {
      _clients: Array<AttendanceManagedPgClient & { release?: (error?: boolean) => void }>
    })._clients
    for (const client of [...clients]) {
      try { client.release?.(true) } catch { /* already returned to the idle pool */ }
    }
    await pool.end()
  }
})

describe('attendance owning sessions on the pinned pg protocol lifecycle', () => {
  it('refuses raw, unobserved, structurally forged and copied capabilities', async () => {
    const plain = new Client({ host: 'unused.invalid' })
    const managedButNotCheckedOut = new AttendanceManagedPgClient({ host: 'unused.invalid' })
    for (const value of [plain, managedButNotCheckedOut, { query: vi.fn(), readyForQuery: true }]) {
      expect(() => attendanceOwningSessionForClientV1(value)).toThrowError(expect.objectContaining(refusal))
    }
    const { connect, wires } = fixture()
    const client = await connect()
    const session = attendanceOwningSessionForClientV1(client)
    expect(Reflect.get(session, 'query')).toBeUndefined()
    expect(Object.keys(session)).toEqual([])
    const body = vi.fn()
    await expect(withAttendanceExclusiveIdleSessionV1(
      { ...session } as AttendanceOwningSessionV1, body,
    )).rejects.toMatchObject(refusal)
    expect(body).not.toHaveBeenCalled()
    expect(wires[0].sql).toEqual([])
  })

  it('never exports protocol transport through custom Query submit or raw listener introspection', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const custom = new Query('SELECT custom_transport_probe')
    custom.on('error', () => undefined)
    const submit = vi.spyOn(custom, 'submit')
    expect(() => client.query(custom)).toThrowError(expect.objectContaining(refusal))
    expect(submit).not.toHaveBeenCalled()
    expect(Reflect.get(client, 'listeners')).toBeUndefined()
    expect(Reflect.get(client, 'rawListeners')).toBeUndefined()
    expect(wires[0].sql).toEqual([])
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      assertAttendanceLeaseIsIdleV1(lease)
    })
  })

  it('does not leak a reusable native client through event meta-listener callbacks', async () => {
    const { connect, wires } = fixture()
    const first = await connect()
    const internal: Array<(error: object) => void> = []
    try {
      first.on('newListener', (event: string, listener: (error: object) => void) => {
        if (event === 'error') internal.push(listener)
      })
    } catch (error) {
      expect(error).toMatchObject(refusal)
    }
    first.release()
    let raw: Client | undefined
    const sentinel = new Error('synthetic_listener_capture')
    for (const listener of internal) {
      const error = Object.defineProperty({}, 'client', {
        set(value: Client) { raw = value; throw sentinel },
      })
      try { listener(error) } catch (caught) { expect(caught).toBe(sentinel) }
    }
    const second = await connect()
    await command(second, wires[0], 'BEGIN', 'T')
    if (raw) {
      const unauthorized = raw.query('COMMIT')
      wires[0].complete('COMMIT', 'I')
      await unauthorized
    }
    await command(second, wires[0], 'ROLLBACK', 'I')
    second.release()
    expect(wires[0].sql).not.toContain('COMMIT')
    expect(raw).toBeUndefined()
    expect(internal).toEqual([])
  })

  it.each([
    ['on', 'newListener'], ['on', 'removeListener'],
    ['addListener', 'newListener'], ['addListener', 'removeListener'],
    ['once', 'newListener'], ['once', 'removeListener'],
    ['prependListener', 'newListener'], ['prependListener', 'removeListener'],
    ['prependOnceListener', 'newListener'], ['prependOnceListener', 'removeListener'],
  ])('refuses event meta-listener registration through %s for %s', async (adder, event) => {
    const { connect, wires } = fixture()
    const client = await connect()
    expect(() => Reflect.apply(Reflect.get(client, adder), client, [event, vi.fn()]))
      .toThrowError(expect.objectContaining(refusal))
    expect(wires[0].sql).toEqual([])
  })

  it('uses protocol I for admission, without a probe, and observes BEGIN/COMMIT state', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const wire = wires[0]
    const session = attendanceOwningSessionForClientV1(client)
    await withAttendanceExclusiveIdleSessionV1(session, async lease => {
      assertAttendanceLeaseIsIdleV1(lease)
      expect(wire.sql).toEqual([])
      const begin = lease.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      expect(() => assertAttendanceLeaseIsIdleV1(lease)).toThrow()
      wire.complete('BEGIN', 'T')
      await begin
      expect(() => assertAttendanceLeaseIsIdleV1(lease)).toThrow()
      const commit = lease.query('COMMIT')
      wire.complete('COMMIT', 'I')
      await commit
      assertAttendanceLeaseIsIdleV1(lease)
    })
    expect(wire.sql).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT'])
  })

  it.each(['T', 'E', '?'])('refuses ReadyForQuery %s without query/body/release/uncertainty effects', async status => {
    const { pool, connect, wires } = fixture()
    const client = await connect()
    const wire = wires[0]
    if (status === 'E') {
      await command(client, wire, 'BEGIN', 'T')
      const rejected = expect(client.query('SELECT synthetic_error')).rejects.toMatchObject({ code: '22012' })
      wire.fail()
      wire.ready('E')
      await rejected
    } else {
      await command(client, wire, 'BEGIN', status)
    }
    const before = [...wire.sql]
    const body = vi.fn()
    const released = vi.fn()
    pool.on('release', released)
    const failure = await withAttendanceExclusiveIdleSessionV1(
      attendanceOwningSessionForClientV1(client), body,
    ).catch(error => error as Error)
    expect(failure).toMatchObject(refusal)
    expect(Reflect.get(failure as object, Symbol.for('ms2.attendance.w4.connectionUncertain'))).toBeUndefined()
    expect(body).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
    expect(wire.sql).toEqual(before)
  })

  it('does not confuse a rejected query with the later ReadyForQuery', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const wire = wires[0]
    const session = attendanceOwningSessionForClientV1(client)
    const query = client.query('SELECT synthetic_error')
    const rejected = expect(query).rejects.toMatchObject({ code: '22012' })
    wire.fail()
    await rejected
    const body = vi.fn()
    await expect(withAttendanceExclusiveIdleSessionV1(session, body)).rejects.toMatchObject(refusal)
    expect(wire.sql).toEqual(['SELECT synthetic_error'])
    wire.ready('E')
    await tick()
    await expect(withAttendanceExclusiveIdleSessionV1(session, body)).rejects.toMatchObject(refusal)
    await command(client, wire, 'ROLLBACK', 'I')
    await withAttendanceExclusiveIdleSessionV1(session, async lease => assertAttendanceLeaseIsIdleV1(lease))
    expect(body).not.toHaveBeenCalled()
  })

  it('rejects in-flight and queued BEGIN even when the preceding ReadyForQuery was I', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const wire = wires[0]
    const session = attendanceOwningSessionForClientV1(client)
    const first = client.query('SELECT before_begin')
    const begin = client.query('BEGIN')
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    wire.complete()
    await first
    expect(wire.sql).toEqual(['SELECT before_begin', 'BEGIN'])
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    wire.complete('BEGIN', 'T')
    await begin
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    await command(client, wire, 'ROLLBACK', 'I')
  })

  it('enforces the lease against raw query/release/end aliases and callback release', async () => {
    const { pool, wires } = fixture()
    const { client, done } = await new Promise<{ client: PoolClient; done: (error?: Error) => void }>((resolve, reject) => {
      pool.connect((error, acquired, release) => {
        if (error) reject(error)
        else resolve({ client: acquired!, done: release })
      })
    })
    const query = client.query.bind(client)
    const release = client.release
    const end = (client as Endable).end
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      await expect(query('BEGIN')).rejects.toMatchObject(refusal)
      await new Promise<void>(resolve => client.query('BEGIN', error => {
        expect(error).toMatchObject(refusal)
        resolve()
      }))
      expect(release).toThrow()
      expect(done).toThrow()
      await expect(end()).rejects.toMatchObject(refusal)
      assertAttendanceLeaseIsIdleV1(lease)
      expect(wires[0].sql).toEqual([])
    })
    done()
    expect(pool.idleCount).toBe(1)
  })

  it('uses fresh facade generations and refuses all saved old-checkout capabilities', async () => {
    const { pool, connect, wires } = fixture()
    const first = await connect()
    const oldSession = attendanceOwningSessionForClientV1(first)
    const oldQuery = first.query
    const oldRelease = first.release
    const oldEnd = (first as Endable).end
    first.release()
    const second = await connect()
    expect(second).not.toBe(first)
    expect(pool.totalCount).toBe(1)
    expect(wires).toHaveLength(1)
    await expect(oldQuery('BEGIN')).rejects.toMatchObject(refusal)
    expect(oldRelease).toThrow()
    await expect(oldEnd()).rejects.toMatchObject(refusal)
    expect(() => first.on('notice', () => undefined)).toThrow()
    expect(() => attendanceOwningSessionForClientV1(first)).toThrow()
    await expect(withAttendanceExclusiveIdleSessionV1(oldSession, vi.fn())).rejects.toMatchObject(refusal)
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(second), async lease => {
      assertAttendanceLeaseIsIdleV1(lease)
    })
    expect(wires[0].sql).toEqual([])
  })

  it('never leaks the reusable driver through pool events, fluent listeners, or listener this', async () => {
    const { pool, connect, wires } = fixture()
    const eventClients: PoolClient[] = []
    pool.on('connect', client => eventClients.push(client))
    pool.on('acquire', client => eventClients.push(client))
    const client = await connect()
    expect(eventClients).toEqual([client, client])
    const listener = vi.fn()
    expect(client.on('notice', listener)).toBe(client)
    expect(client.removeListener('notice', listener)).toBe(client)
    const receiver: unknown[] = []
    expect(client.once('notice', function (this: unknown) { receiver.push(this) })).toBe(client)
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async () => {
      wires[0].notice()
      await tick()
      expect(receiver[0]).toBe(client)
      expect(Reflect.get(client, 'connection')).toBeUndefined()
      expect(Reflect.get(client, 'constructor')).toBeUndefined()
      expect(Reflect.get(client, 'emit')).toBeUndefined()
      await expect((receiver[0] as PoolClient).query('BEGIN')).rejects.toMatchObject(refusal)
    })
  })

  it('composes only the active idle lease, excludes competing owners, and revokes child/body ports', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const session = attendanceOwningSessionForClientV1(client)
    let childPort: AttendanceSessionLeaseV1
    let outerPort: AttendanceSessionLeaseV1
    await withAttendanceExclusiveIdleSessionV1(session, async outer => {
      outerPort = outer
      await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
      await withAttendanceExclusiveIdleSessionV1(outer, async child => {
        childPort = child
        assertAttendanceLeaseIsIdleV1(child)
        expect(() => assertAttendanceLeaseIsIdleV1(outer)).toThrow()
        await expect(outer.query('BEGIN')).rejects.toMatchObject(refusal)
      })
      assertAttendanceLeaseIsIdleV1(outer)
      await expect(childPort!.query('BEGIN')).rejects.toMatchObject(refusal)
      const begin = outer.query('BEGIN')
      wires[0].complete('BEGIN', 'T')
      await begin
      await expect(withAttendanceExclusiveIdleSessionV1(outer, vi.fn())).rejects.toMatchObject(refusal)
      const rollback = outer.query('ROLLBACK')
      wires[0].complete('ROLLBACK', 'I')
      await rollback
    })
    await expect(outerPort!.query('BEGIN')).rejects.toMatchObject(refusal)
    expect(wires[0].sql).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('retains exclusion for an unawaited query until its actual ReadyForQuery', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    let pending: Promise<unknown>
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      pending = lease.query('SELECT detached')
    })
    await expect(client.query('BEGIN')).rejects.toMatchObject(refusal)
    expect(() => client.release()).toThrow()
    wires[0].complete()
    await pending!
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      assertAttendanceLeaseIsIdleV1(lease)
    })
  })

  it('destroys only its own unfinished transaction on release without issuing cleanup SQL', async () => {
    const { pool, connect, wires } = fixture()
    const client = await connect()
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      const begin = lease.query('BEGIN')
      wires[0].complete('BEGIN', 'T')
      await begin
    })
    expect(() => client.release()).not.toThrow()
    expect(pool.idleCount).toBe(0)
    expect(pool.totalCount).toBe(0)
    expect(wires[0].sql).toEqual(['BEGIN'])
  })

  it('an owned query failure swallowed by its body still destroys an unresolved checkout on release', async () => {
    const { pool, connect, wires } = fixture()
    const client = await connect()
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      const query = lease.query('SELECT synthetic_query_failure')
      wires[0].fail()
      await expect(query).rejects.toMatchObject({ code: '22012' })
      // Withhold ReadyForQuery: a rejected promise alone is not idle evidence.
    })
    expect(() => client.release()).not.toThrow()
    expect(pool.idleCount).toBe(0)
    expect(pool.totalCount).toBe(0)
    expect(wires[0].sql).toEqual(['SELECT synthetic_query_failure'])
  })

  it('release observer counts duplicate attempts separately from accepted pool events', async () => {
    const constructor = globalThis.Proxy
    const { pool, connect } = fixture(AttendanceReleaseObservedPool)
    const observed = pool as AttendanceReleaseObservedPool
    const client = await connect()
    expect(globalThis.Proxy).toBe(constructor)
    const events: unknown[] = []
    pool.on('release', error => events.push(error))
    client.release()
    expect(() => client.release()).toThrowError(expect.objectContaining(refusal))
    expect(observed.releaseAttempts.get(client)).toEqual([undefined, undefined])
    expect(events).toEqual([undefined])
  })

  it('release observer records an active-owner refused attempt before any pool event', async () => {
    const { pool, connect } = fixture(AttendanceReleaseObservedPool)
    const observed = pool as AttendanceReleaseObservedPool
    const client = await connect()
    const events: unknown[] = []
    pool.on('release', error => events.push(error))
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async () => {
      expect(() => client.release()).toThrowError(expect.objectContaining(refusal))
      expect(observed.releaseAttempts.get(client)).toEqual([undefined])
      expect(events).toEqual([])
    })
    client.release()
    expect(observed.releaseAttempts.get(client)).toEqual([undefined, undefined])
    expect(events).toEqual([undefined])
  })

  it('release observer preserves caller argument identity separately from owned disposition', async () => {
    const { pool, connect, wires } = fixture(AttendanceReleaseObservedPool)
    const observed = pool as AttendanceReleaseObservedPool
    const client = await connect()
    const events: unknown[] = []
    pool.on('release', error => events.push(error))
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      const begin = lease.query('BEGIN')
      wires[0].complete('BEGIN', 'T')
      await begin
    })
    client.release()
    expect(observed.releaseAttempts.get(client)).toEqual([undefined])
    expect(events).toEqual([expect.objectContaining({ message: 'W4C0_OWNER_SESSION_UNSETTLED' })])
    expect(pool.totalCount).toBe(0)
    expect(wires[0].sql).toEqual(['BEGIN'])
  })

  it('checkout listener cleanup prevents stale callbacks on a reused backend', async () => {
    const { connect, wires } = fixture()
    const first = await connect()
    const stale = vi.fn()
    first.on('notice', stale)
    first.release()
    const second = await connect()
    const currentListener = vi.fn()
    second.on('notice', currentListener)
    wires[0].notice()
    await tick()
    expect(stale).not.toHaveBeenCalled()
    expect(currentListener).toHaveBeenCalledTimes(1)
    second.release()
  })

  it('checkout listener cleanup leaves refused-release listeners active and suppresses captured later callbacks', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const kept = vi.fn()
    client.on('notice', kept)
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async () => {
      expect(() => client.release()).toThrowError(expect.objectContaining(refusal))
      wires[0].notice()
      await tick()
      expect(kept).toHaveBeenCalledTimes(1)
    })
    client.off('notice', kept)
    client.on('notice', () => client.release())
    const afterRelease = vi.fn()
    client.on('notice', afterRelease)
    wires[0].notice()
    await tick()
    expect(afterRelease).not.toHaveBeenCalled()
  })

  it.each(['promise', 'callback'])('fences checkout end during an owning lease: %s', async mode => {
    const { connect, wires } = fixture()
    const client = await connect()
    await withAttendanceExclusiveIdleSessionV1(attendanceOwningSessionForClientV1(client), async lease => {
      const ending = mode === 'promise'
        ? client.end()
        : new Promise<void>((resolve, reject) => client.end(error => error ? reject(error) : resolve()))
      await expect(ending).rejects.toMatchObject(refusal)
      expect(wires[0].destroyed).toBe(false)
      const query = lease.query('SELECT still_owned')
      wires[0].complete()
      await query
      assertAttendanceLeaseIsIdleV1(lease)
    })
    client.release()
    expect(wires[0].sql).toEqual(['SELECT still_owned'])
  })

  it('does not treat pg read-timeout rejection as protocol completion', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const session = attendanceOwningSessionForClientV1(client)
    const config = { text: 'SELECT delayed', query_timeout: 1 }
    await expect(client.query(config)).rejects.toThrow('Query read timeout')
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    wires[0].complete()
    await tick()
    await withAttendanceExclusiveIdleSessionV1(session, async lease => assertAttendanceLeaseIsIdleV1(lease))
  })

  it('fails closed on backend transport replacement and never rehabilitates that client', async () => {
    const { pool, connect, wires } = fixture()
    const client = await connect()
    const raw = (pool as unknown as {
      _clients: Array<{ connection: { stream: unknown } }>
    })._clients[0]
    const original = raw.connection.stream
    const session = attendanceOwningSessionForClientV1(client)
    await withAttendanceExclusiveIdleSessionV1(session, async lease => {
      raw.connection.stream = {}
      try {
        await expect(lease.query('BEGIN')).rejects.toMatchObject(refusal)
      } finally {
        raw.connection.stream = original
      }
    })
    wires[0].ready('I')
    await tick()
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    expect(wires[0].sql).toEqual([])
  })

  it('invalidates a previously idle session on transport end', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const session = attendanceOwningSessionForClientV1(client)
    wires[0].destroy()
    await tick()
    await expect(withAttendanceExclusiveIdleSessionV1(session, vi.fn())).rejects.toMatchObject(refusal)
    expect(wires[0].sql).toEqual([])
  })

  it('preserves exact custom refusal identity without marking caller state uncertain', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    await command(client, wires[0], 'BEGIN', 'T')
    const error = Object.assign(new Error('W4C0_CONNECTION_NOT_IDLE'), { code: 'W4C0_CONNECTION_NOT_IDLE' })
    await expect(withAttendanceExclusiveIdleSessionV1(
      attendanceOwningSessionForClientV1(client), vi.fn(), () => error,
    )).rejects.toBe(error)
    expect(() => assertAttendanceLeaseIsIdleV1({} as AttendanceSessionLeaseV1, () => error)).toThrow(error)
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
  })

  it('overrides only exact COMMIT through a native config and never mutates the supplied config', async () => {
    const { connect, wires } = fixture()
    const client = await connect()
    const session = attendanceOwningSessionForClientV1(client, { commitQueryTimeoutMs: 180000 })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await withAttendanceExclusiveIdleSessionV1(session, async lease => {
      const config = { text: 'COMMIT', values: [], query_timeout: 31 }
      const commit = lease.query(config)
      expect(timer.mock.calls.at(-1)?.[1]).toBe(180000)
      wires[0].complete('COMMIT')
      await commit
      expect(config).toEqual({ text: 'COMMIT', values: [], query_timeout: 31 })
      const lower = lease.query({ text: 'commit', query_timeout: 41 })
      expect(timer.mock.calls.at(-1)?.[1]).toBe(41)
      wires[0].complete('COMMIT')
      await lower
      const begin = lease.query({ text: 'BEGIN', query_timeout: 51 })
      expect(timer.mock.calls.at(-1)?.[1]).toBe(51)
      wires[0].complete('BEGIN', 'T')
      await begin
      const rollback = lease.query('ROLLBACK')
      wires[0].complete('ROLLBACK', 'I')
      await rollback
    })
    expect(wires[0].sql).toEqual(['COMMIT', 'commit', 'BEGIN', 'ROLLBACK'])
  })

  it('keeps pool.query Promise/callback behavior and automatic checkout release', async () => {
    const { pool, wires } = fixture()
    const promise = pool.query('SELECT promise')
    await tick()
    wires[0].complete()
    expect((await promise).rows).toEqual([])
    expect(pool.idleCount).toBe(1)
    const callback = new Promise<unknown>((resolve, reject) => pool.query('SELECT callback', (error, result) => {
      if (error) reject(error)
      else resolve(result.rows)
    }))
    await tick()
    wires[0].complete()
    await expect(callback).resolves.toEqual([])
    expect(pool.idleCount).toBe(1)
    expect(wires[0].sql).toEqual(['SELECT promise', 'SELECT callback'])
  })
})
