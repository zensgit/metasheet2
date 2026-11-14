import { Duplex } from 'node:stream'
import { Client } from 'pg'
import type { PoolClient } from 'pg'
import { vi } from 'vitest'
import {
  AttendanceManagedPgPool,
  attendanceOwningSessionForClientV1,
} from '../../src/attendance/attendance-owning-session'

type QueryScript = (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type Status = 'I' | 'T' | 'E' | '?'

function frame(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type)
  header.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([header, payload])
}

/**
 * Unit-only wire: real pg startup/parser and managed checkout/lease identity.
 * Business results/errors come from a native-query script BELOW the managed
 * dispatcher. This is not real PostgreSQL or proof of the native query driver.
 */
class UnitWire extends Duplex {
  private startup = true
  constructor(private readonly initialStatus: Status) { super() }
  _read(): void {}
  setNoDelay(): void {}
  setKeepAlive(): void {}
  ref(): void {}
  unref(): void {}
  connect(): void { queueMicrotask(() => this.emit('connect')) }

  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.startup) {
      this.startup = false
      queueMicrotask(() => {
        const backend = Buffer.alloc(8)
        backend.writeInt32BE(123, 0)
        backend.writeInt32BE(456, 4) // synthetic, never a live backend key
        this.push(Buffer.concat([
          frame('R', Buffer.alloc(4)),
          frame('K', backend),
          frame('Z', Buffer.from(this.initialStatus)),
        ]))
      })
    }
    done()
  }

  _final(done: (error?: Error | null) => void): void {
    done()
    this.destroy()
  }

  ready(status: Status): void { this.push(frame('Z', Buffer.from(status))) }
}

const scripts = new Map<Client, (args: unknown[]) => Promise<unknown>>()
const cleanups: Array<() => Promise<void>> = []
let restoreQuery: (() => void) | undefined

function installQueryScriptDispatcher(): void {
  if (restoreQuery) return
  const original = Client.prototype.query
  const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    const script = scripts.get(this)
    return script ? script(args) : Reflect.apply(original, this, args)
  } as Client['query'])
  restoreQuery = () => spy.mockRestore()
}

export async function createAttendanceOwningSessionUnitFixture(
  query: QueryScript,
  options: {
    initialStatus?: Status
    onRelease?: (error?: Error) => void
    onNativeQuery?: (statement: unknown, values?: unknown[]) => void
  } = {},
) {
  const initialStatus = options.initialStatus ?? 'I'
  const wire = new UnitWire(initialStatus)
  const pool = new AttendanceManagedPgPool({
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 0,
    ssl: false,
    user: 'synthetic',
    password: 'synthetic',
    database: 'synthetic',
    host: 'unused.invalid',
    stream: () => wire,
  })
  const acquired: { checkout?: PoolClient; raw?: Client } = {}
  let released = false
  cleanups.push(async () => {
    if (acquired.raw) scripts.delete(acquired.raw)
    if (acquired.checkout && !released) acquired.checkout.release(true)
    await pool.end()
  })
  const checkout = await pool.connect()
  acquired.checkout = checkout
  // Test-only native receiver selection; never stamp or forge a query object.
  const raw = (pool as unknown as { _clients: Client[] })._clients[0]
  acquired.raw = raw
  installQueryScriptDispatcher()
  let status = initialStatus
  const ready = async (next: Status) => {
    status = next
    await new Promise<void>(resolve => {
      raw!.connection.once('readyForQuery', () => queueMicrotask(resolve))
      wire.ready(next)
    })
  }
  scripts.set(raw, async args => {
    const [statement, values] = args as [string | { text: string; values?: unknown[] }, unknown[]?]
    const text = typeof statement === 'string' ? statement : statement.text
    let result: Awaited<ReturnType<QueryScript>>
    try {
      // Observe native arity/receiver unchanged; this does not grant ownership.
      if (options.onNativeQuery) Reflect.apply(options.onNativeQuery, raw, args)
      result = await query(text, values ?? (typeof statement === 'string' ? undefined : statement.values))
    } catch (error) {
      // Scripted SQL failures abort a transaction; settlement failures remain
      // unknown. Preserve the exact thrown object, including frozen objects.
      await ready(text === 'COMMIT' || text === 'ROLLBACK' ? '?' : status === 'T' ? 'E' : status)
      throw error
    }
    await ready(text.startsWith('BEGIN') ? 'T' : text === 'COMMIT' || text === 'ROLLBACK' ? 'I' : status)
    return result
  })
  const client = attendanceOwningSessionForClientV1(checkout)
  return {
    client,
    checkout,
    release(error?: Error): void {
      checkout!.release(error)
      released = true
      options.onRelease?.(error)
    },
  }
}

/** Register with each consumer's afterEach; no test cases are registered here. */
export async function disposeAttendanceOwningSessionUnitFixtures(): Promise<void> {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  } finally {
    scripts.clear()
    restoreQuery?.()
    restoreQuery = undefined
  }
}
