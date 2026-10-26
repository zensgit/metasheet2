import { Client } from 'pg'
import type { Pool, PoolClient } from 'pg'
import { afterEach, vi } from 'vitest'
import {
  AttendanceManagedPgPool,
  attendanceOwningSessionForClientV1,
  type AttendanceOwningSessionV1,
} from '../../src/attendance/attendance-owning-session'

type NativeClient = Client & { processID: number }
type NativeQuery = (...args: unknown[]) => unknown

export interface AttendanceOwnedNativeQueryCall {
  readonly args: readonly unknown[]
  readonly text: string
  readonly values: unknown[] | undefined
  /** No arguments forwards the exact native arguments, including QueryConfig,
   * callback and Query-object forms. Explicit arguments are a test's override. */
  next(...args: unknown[]): unknown
}

// A recorder returns next() directly, preserving native callback/Query return
// forms. Settlement fault interceptors below use the promise form issued by
// owning leases; native QueryConfig and callbacks are never stripped here.
type Interceptor = (call: AttendanceOwnedNativeQueryCall) => unknown
type Registration = { native: NativeClient; intercept: Interceptor; removeReleaseListener(): void }

/**
 * Test-only access to pg-pool's pinned private client inventory. The public
 * managed checkout remains the only input to the production trust issuer.
 * This observer runs BELOW the managed dispatcher/lease; it never stamps idle
 * state, wraps a query-only port as an owner, or issues SQL via the raw facade.
 */
export function attendanceNativeClientForCheckoutV1(
  pool: Pool,
  checkout: PoolClient,
): NativeClient {
  attendanceOwningSessionForClientV1(checkout)
  if (!(pool instanceof AttendanceManagedPgPool)) throw new Error('ATTENDANCE_TEST_MANAGED_POOL_REQUIRED')
  const clients = (pool as unknown as { _clients: NativeClient[] })._clients
  const native = clients.find(client => client.processID === (checkout as PoolClient & { processID: number }).processID)
  if (!native) throw new Error('ATTENDANCE_TEST_NATIVE_CHECKOUT_NOT_FOUND')
  return native
}

let restoreSpy: (() => void) | undefined
const registrations: Registration[] = []

function restoreRegistration(registration: Registration): void {
  const index = registrations.indexOf(registration)
  if (index < 0) return
  registration.removeReleaseListener()
  registrations.splice(index, 1)
  if (registrations.length === 0) {
    restoreSpy?.()
    restoreSpy = undefined
  }
}

afterEach(() => {
  for (const registration of [...registrations]) restoreRegistration(registration)
})

export function attendanceOwnedNativeQueryProbeV1(
  pool: Pool,
  checkout: PoolClient,
  intercept: Interceptor,
): { session: AttendanceOwningSessionV1; restore(): void } {
  const session = attendanceOwningSessionForClientV1(checkout)
  const native = attendanceNativeClientForCheckoutV1(pool, checkout)
  if (!restoreSpy) {
    const query = Client.prototype.query as unknown as NativeQuery
    const spy = vi.spyOn(Client.prototype, 'query')
    spy.mockImplementation(function (this: NativeClient, ...args: unknown[]) {
      const registration = [...registrations].reverse().find(item => item.native === this)
      if (!registration) return Reflect.apply(query, this, args)
      const statement = args[0]
      const config = typeof statement === 'object' && statement !== null
        ? statement as { text?: unknown; values?: unknown[] } : undefined
      const text = typeof statement === 'string' ? statement
        : typeof config?.text === 'string' ? config.text : ''
      const values = Array.isArray(args[1]) ? args[1]
        : Array.isArray(config?.values) ? config.values : undefined
      return registration.intercept({
        args, text, values,
        next: (...replacement: unknown[]) => Reflect.apply(query, this, replacement.length ? replacement : args),
      })
    } as Client['query'])
    restoreSpy = () => spy.mockRestore()
  }
  const onRelease = (_error: unknown, released: PoolClient) => {
    if (released === checkout) restoreRegistration(registration)
  }
  const registration: Registration = {
    native, intercept,
    removeReleaseListener: () => { pool.removeListener('release', onRelease) },
  }
  registrations.push(registration)
  pool.on('release', onRelease)
  return { session, restore: () => restoreRegistration(registration) }
}

/** A query-only body port for fixture code outside an owning lease. */
export function attendanceFixtureQueryPortV1(checkout: PoolClient) {
  return {
    query: async (statement: string, values?: readonly unknown[]) => {
      const result = await checkout.query(statement, values ? [...values] : undefined)
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
  }
}
