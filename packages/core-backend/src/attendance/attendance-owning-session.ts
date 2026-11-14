import { Client, Pool } from 'pg'
import type { ClientConfig, PoolClient, PoolConfig, QueryConfig } from 'pg'

/**
 * Pinned to the JS pg 8.16.3 / pg-pool 3.10.1 lifecycle. The private driver hooks
 * below are deliberately confined here. A checkout facade is the public client;
 * pg's connection/stream, pool internals and direct prototype calls are not an
 * application API. The transport must retain the same backend for its lifetime.
 */
declare const sessionBrand: unique symbol
declare const leaseBrand: unique symbol

export interface AttendanceOwningSessionV1 {
  readonly [sessionBrand]: true
}

type NativeQueryConfig = QueryConfig<unknown[]> & { query_timeout?: number }

export interface AttendanceSessionLeaseV1 {
  readonly [leaseBrand]: true
  query(
    statement: string | NativeQueryConfig,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

type Refusal = () => Error
type Release = (error?: Error | boolean) => void
type Listener = (...args: unknown[]) => void
type Driver = AttendanceManagedPgClient & {
  activeQuery?: unknown
  queryQueue: unknown[]
  readyForQuery?: boolean
  _connected?: boolean
  _queryable?: boolean
  _ending?: boolean
  _ended?: boolean
  processID?: number
}
type ProtocolConnection = Client['connection'] & { stream: unknown }
type PendingItem = {
  timedOut?: boolean
  callback(error?: Error, client?: PoolClient, release?: Release): void
}
type ClientHooks = {
  _handleReadyForQuery(message: { status: string }): void
  _handleBackendKeyData(message: { processID: number; secretKey: number }): void
  _handleErrorEvent(error: Error): void
  _handleErrorWhileConnecting(error: Error): void
  _pulseQueryQueue(): void
}
type PoolHooks = {
  _acquireClient(client: AttendanceManagedPgClient, pending: PendingItem, idle: Listener, isNew: boolean): void
  _releaseOnce(client: AttendanceManagedPgClient, idle: Listener): Release
}
type State = {
  client: Driver
  connection: ProtocolConnection
  stream?: unknown
  backend?: number
  status: 'I' | 'T' | 'E' | 'unknown'
  busy: boolean
  handlingReady: boolean
  failed: boolean
  generation: number
  checkout?: Checkout
  owner?: Owner
}
type Checkout = {
  state: State
  generation: number
  active: boolean
  facade: PoolClient
  release?: Release
  removeApplicationListeners?: () => void
}
type Session = { checkout: Checkout; commitQueryTimeoutMs?: number }
type Owner = { session: Session; current: Lease; closed: boolean; failed: boolean }
type Lease = { owner: Owner; active: boolean; facade: AttendanceSessionLeaseV1 }

const clientHooks = Client.prototype as unknown as ClientHooks
const poolHooks = Pool.prototype as unknown as PoolHooks
const states = new WeakMap<AttendanceManagedPgClient, State>()
const checkouts = new WeakMap<object, Checkout>()
const sessions = new WeakMap<object, Session>()
const leases = new WeakMap<object, Lease>()

function refusalError(): Error {
  return Object.assign(new Error('W4C0_CONNECTION_NOT_IDLE'), { code: 'W4C0_CONNECTION_NOT_IDLE' })
}

function refuse(refusal: Refusal = refusalError): never {
  throw refusal()
}

function objectKey(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function current(checkout: Checkout): boolean {
  return checkout.active && checkout.state.checkout === checkout
    && checkout.generation === checkout.state.generation
}

function sameBackend(state: State): boolean {
  const client = state.client
  const stream = state.stream as { destroyed?: boolean; writableEnded?: boolean } | undefined
  if (stream?.destroyed || stream?.writableEnded || client.connection !== state.connection
    || (state.stream !== undefined && state.connection.stream !== state.stream)
    || (state.backend !== undefined && client.processID !== state.backend)) {
    state.failed = true
    state.status = 'unknown'
  }
  return !state.failed && client._connected === true && client._queryable === true
    && !client._ending && !client._ended && state.backend !== undefined && state.stream !== undefined
}

function quiescent(state: State): boolean {
  return !state.busy && !state.handlingReady && state.client.readyForQuery === true
    && !state.client.activeQuery && state.client.queryQueue.length === 0
}

function idle(checkout: Checkout): boolean {
  return current(checkout) && sameBackend(checkout.state)
    && quiescent(checkout.state) && checkout.state.status === 'I'
}

function activeLease(lease: Lease): boolean {
  const { owner } = lease
  return lease.active && !owner.closed && owner.current === lease
    && owner.session.checkout.state.owner === owner && current(owner.session.checkout)
}

function retireClosedOwner(state: State): void {
  // Retain ownership of unresolved work so host release cannot recycle a T/E
  // checkout. A successful detached query still fences outside use until ready.
  if (state.owner?.closed && idle(state.owner.session.checkout)) state.owner = undefined
}

function invalidate(state: State): void {
  state.failed = true
  state.status = 'unknown'
  state.busy = true
}

function submit(args: unknown[], state: State): unknown {
  state.busy = true
  state.status = 'unknown'
  return Reflect.apply(Client.prototype.query, state.client, args)
}

function rejectedQuery(args: unknown[], error: Error): unknown {
  const config = args[0] as { callback?: unknown; submit?: unknown } | undefined
  const callback = [...args].reverse().find(value => typeof value === 'function') ?? config?.callback
  if (typeof callback === 'function') {
    queueMicrotask(() => callback(error))
    return undefined
  }
  if (typeof config?.submit === 'function') throw error
  return Promise.reject(error)
}

function publicQuery(args: unknown[], state: State, checkout?: Checkout): unknown {
  // pg's custom submit callback receives its raw protocol connection. Supporting
  // it would let a caller retain that transport and bypass every later lease.
  const input = args[0] as { submit?: unknown } | null | undefined
  if (input && typeof input.submit === 'function') return rejectedQuery(args, refusalError())
  if ((checkout && !current(checkout)) || state.owner) return rejectedQuery(args, refusalError())
  return submit(args, state)
}

export class AttendanceManagedPgClient extends Client {
  declare queryQueue: unknown[]

  constructor(config?: string | ClientConfig) {
    super(config)
    if (typeof clientHooks._handleReadyForQuery !== 'function'
      || typeof clientHooks._pulseQueryQueue !== 'function') refuse()
    const state: State = {
      client: this as Driver,
      connection: this.connection as ProtocolConnection,
      status: 'unknown',
      busy: true,
      handlingReady: false,
      failed: false,
      generation: 0,
    }
    states.set(this, state)
    // Installed before connect; an end cannot leave an earlier I admissible.
    this.connection.on('end', () => invalidate(state))
  }

  query: Client['query'] = ((...args: unknown[]) =>
    publicQuery(args, states.get(this)!)) as Client['query']

  _handleBackendKeyData(message: { processID: number; secretKey: number }): void {
    const state = states.get(this)!
    if (state.backend !== undefined) invalidate(state)
    else state.backend = message.processID
    clientHooks._handleBackendKeyData.call(this, message)
  }

  _handleReadyForQuery(message: { status: string }): void {
    const state = states.get(this)!
    if (state.stream === undefined) state.stream = state.connection.stream
    // Record the actual protocol byte before pg resolves connect/query callbacks.
    state.status = message.status === 'I' || message.status === 'T' || message.status === 'E'
      ? message.status : 'unknown'
    state.busy = false
    state.handlingReady = true
    try {
      clientHooks._handleReadyForQuery.call(this, message)
    } finally {
      state.handlingReady = false
      sameBackend(state)
      retireClosedOwner(state)
    }
  }

  _pulseQueryQueue(): void {
    const state = states.get(this)!
    if (state.client.readyForQuery === true && state.client.queryQueue.length > 0) {
      state.busy = true
      state.status = 'unknown'
    }
    clientHooks._pulseQueryQueue.call(this)
  }

  _handleErrorEvent(error: Error): void {
    invalidate(states.get(this)!)
    clientHooks._handleErrorEvent.call(this, error)
  }

  _handleErrorWhileConnecting(error: Error): void {
    invalidate(states.get(this)!)
    clientHooks._handleErrorWhileConnecting.call(this, error)
  }

  end(): Promise<void>
  end(callback: (error: Error) => void): void
  end(callback?: (error: Error) => void): Promise<void> | void {
    const state = states.get(this)!
    if (state.owner && !state.owner.closed) {
      if (callback) { queueMicrotask(() => callback(refusalError())); return }
      return Promise.reject(refusalError())
    }
    invalidate(state)
    if (callback) return super.end(callback)
    return super.end()
  }
}

const eventAdders = new Set(['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'])
const publicMethods = new Set([
  'escapeIdentifier', 'escapeLiteral', 'setTypeParser', 'getTypeParser', 'ref', 'unref',
  'eventNames', 'listenerCount', 'getMaxListeners', 'setMaxListeners',
])
const publicProperties = new Set(['processID', 'user', 'database', 'port', 'host', 'ssl'])

function createFacade(checkout: Checkout): PoolClient {
  const { state } = checkout
  const client = state.client
  const listeners: Array<{ event: string | symbol; original: Listener; wrapped: Listener }> = []
  const methods = new Map<PropertyKey, unknown>()
  checkout.removeApplicationListeners = () => {
    for (const entry of listeners.splice(0)) client.removeListener(entry.event, entry.wrapped)
  }
  const requireCurrent = () => { if (!current(checkout)) refuse() }
  const facade: PoolClient = new Proxy(Object.create(null) as PoolClient, {
    get(_target, key) {
      if (key === Symbol.toStringTag) return 'AttendanceManagedPgCheckout'
      if (methods.has(key)) return methods.get(key)
      let method: unknown
      if (key === 'query') {
        method = (...args: unknown[]) => publicQuery(args, state, checkout)
      } else if (key === 'release') {
        method = (error?: Error | boolean) => {
          requireCurrent()
          if (!checkout.release) refuse()
          checkout.release(error)
        }
      } else if (key === 'end') {
        method = (callback?: (error: Error) => void) => {
          if (!current(checkout)) {
            if (callback) { queueMicrotask(() => callback(refusalError())); return }
            return Promise.reject(refusalError())
          }
          return callback ? client.end(callback) : client.end()
        }
      } else if (typeof key === 'string' && eventAdders.has(key)) {
        method = (event: string | symbol, listener: Listener) => {
          requireCurrent()
          // Emitter meta-events expose internal listener functions/closures.
          if (event === 'newListener' || event === 'removeListener') refuse()
          const wrapped = (...args: unknown[]) => {
            if (!current(checkout)) return undefined
            return Reflect.apply(listener, facade, args.map(value => value === client ? facade : value))
          }
          listeners.push({ event, original: listener, wrapped })
          Reflect.apply(Reflect.get(client, key), client, [event, wrapped])
          return facade
        }
      } else if (key === 'removeListener' || key === 'off') {
        method = (event: string | symbol, listener: Listener) => {
          requireCurrent()
          let index = listeners.length - 1
          while (index >= 0 && (listeners[index].event !== event || listeners[index].original !== listener)) index -= 1
          if (index >= 0) {
            const [entry] = listeners.splice(index, 1)
            client.removeListener(event, entry.wrapped)
          }
          return facade
        }
      } else if (typeof key === 'string' && publicMethods.has(key)) {
        method = (...args: unknown[]) => {
          requireCurrent()
          if (state.owner) refuse()
          const result = Reflect.apply(Reflect.get(client, key), client, args)
          return result === client ? facade : result
        }
      } else if (typeof key === 'string' && publicProperties.has(key)) {
        return Reflect.get(client, key)
      } else {
        // No connection, rawClient, prototype, emit or internal driver methods.
        return undefined
      }
      methods.set(key, method)
      return method
    },
    set() { return refuse() },
    defineProperty() { return refuse() },
    setPrototypeOf() { return false },
  })
  checkouts.set(facade, checkout)
  return facade
}

type ManagedPoolConfig = PoolConfig & {
  verify?: (client: PoolClient, done: (error?: Error) => void) => void
}

export class AttendanceManagedPgPool extends Pool {
  constructor(options: ManagedPoolConfig = {}) {
    if (options.Client && options.Client !== AttendanceManagedPgClient) refuse()
    if (typeof poolHooks._acquireClient !== 'function' || typeof poolHooks._releaseOnce !== 'function') refuse()
    const verify = options.verify
    super({
      ...options,
      Client: AttendanceManagedPgClient,
      ...(verify ? {
        verify: (client: AttendanceManagedPgClient, done: (error?: Error) => void) =>
          verify(states.get(client)!.checkout!.facade, done),
      } : {}),
    })
  }

  _acquireClient(client: AttendanceManagedPgClient, pending: PendingItem, idleListener: Listener, isNew: boolean): void {
    const state = states.get(client)
    if (!state || state.checkout?.active || state.owner) refuse()
    const checkout: Checkout = {
      state, generation: ++state.generation, active: true, facade: undefined as unknown as PoolClient,
    }
    checkout.facade = createFacade(checkout)
    state.checkout = checkout
    poolHooks._acquireClient.call(this, client, {
      ...pending,
      callback: (error, acquired) => {
        // The first pg checkout occurs inside its ReadyForQuery handler. Deliver
        // both callback and Promise clients after that handler finishes draining.
        queueMicrotask(() => pending.callback(error, acquired ? checkout.facade : undefined,
          acquired ? checkout.release : undefined))
      },
    }, idleListener, isNew)
  }

  _releaseOnce(client: AttendanceManagedPgClient, idleListener: Listener): Release {
    const state = states.get(client)!
    const checkout = state.checkout!
    const release = poolHooks._releaseOnce.call(this, client, idleListener)
    const guarded: Release = error => {
      if (!current(checkout) || (state.owner && !state.owner.closed)) refuse()
      const owner = state.owner
      if (owner && !quiescent(state) && !error && !owner.failed && !state.failed) refuse()
      // Only a closed, admitted owner can trigger this disposition. Refusal of
      // borrowed T/E creates no owner and never destroys or rolls back its work.
      const disposition = error || (owner && !idle(checkout)
        ? new Error('W4C0_OWNER_SESSION_UNSETTLED') : undefined)
      checkout.active = false
      state.owner = undefined
      checkout.removeApplicationListeners?.()
      release(disposition)
    }
    checkout.release = guarded
    return guarded
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    // Pool events must not hand out the underlying reusable Client either.
    return super.emit(event, ...args.map(value => {
      if (!(value instanceof AttendanceManagedPgClient)) return value
      const state = states.get(value)!
      if (state.checkout) return state.checkout.facade
      const unavailable: Checkout = {
        state, generation: state.generation, active: false, facade: undefined as unknown as PoolClient,
      }
      unavailable.facade = createFacade(unavailable)
      return unavailable.facade
    }))
  }
}

export function attendanceOwningSessionForClientV1(
  client: unknown,
  options?: { commitQueryTimeoutMs?: number },
): AttendanceOwningSessionV1 {
  const key = objectKey(client)
  const checkout = key && checkouts.get(key)
  if (!checkout || !current(checkout)) refuse()
  const timeout = options?.commitQueryTimeoutMs
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) refuse()
  const session = Object.freeze(Object.create(null)) as AttendanceOwningSessionV1
  sessions.set(session, { checkout, commitQueryTimeoutMs: timeout })
  return session
}

function createLease(owner: Owner): Lease {
  const lease: Lease = { owner, active: true, facade: undefined as unknown as AttendanceSessionLeaseV1 }
  const facade = Object.freeze({
    async query(statement: string | NativeQueryConfig, values?: unknown[]) {
      if (!activeLease(lease) || !sameBackend(owner.session.checkout.state)) refuse()
      // Lease queries deliberately expose only pg's promise/native-config form.
      if (typeof statement !== 'string' && (!statement || typeof statement.text !== 'string'
        || 'submit' in statement || 'callback' in statement)) refuse()
      const text = typeof statement === 'string' ? statement : statement.text
      const timeout = owner.session.commitQueryTimeoutMs
      const overrideCommit = text === 'COMMIT' && timeout !== undefined
      const config = overrideCommit
        ? { ...(typeof statement === 'string' ? { text: statement } : statement),
          values: values !== undefined ? values : typeof statement === 'string' ? undefined : statement.values,
          query_timeout: timeout }
        : statement
      // Preserve the existing COMMIT adapter's one-argument native config,
      // including values; other statements retain pg's original two-argument path.
      try {
        return await submit(overrideCommit ? [config] : [config, values], owner.session.checkout.state) as {
          rows: Array<Record<string, unknown>>
        }
      } catch (error) {
        owner.failed = true
        throw error
      }
    },
  }) as AttendanceSessionLeaseV1
  lease.facade = facade
  leases.set(facade, lease)
  return lease
}

export function assertAttendanceLeaseIsIdleV1(
  value: AttendanceSessionLeaseV1,
  refusal?: Refusal,
): void {
  const key = objectKey(value)
  const lease = key && leases.get(key)
  if (!lease || !activeLease(lease) || !idle(lease.owner.session.checkout)) refuse(refusal)
}

export async function withAttendanceExclusiveIdleSessionV1<T>(
  value: AttendanceOwningSessionV1 | AttendanceSessionLeaseV1,
  body: (lease: AttendanceSessionLeaseV1) => Promise<T>,
  refusal?: Refusal,
): Promise<T> {
  const key = objectKey(value)
  const parent = key && leases.get(key)
  const session = parent ? parent.owner.session : key && sessions.get(key)
  if (typeof body !== 'function' || !session || !idle(session.checkout)) refuse(refusal)
  const state = session.checkout.state
  if (parent ? !activeLease(parent) : state.owner !== undefined) refuse(refusal)
  const owner: Owner = parent ? parent.owner : { session, closed: false, failed: false, current: undefined as unknown as Lease }
  const lease = createLease(owner)
  // No await separates idle verification from installing exclusive ownership.
  owner.current = lease
  state.owner = owner
  try {
    return await body(lease.facade)
  } catch (error) {
    owner.failed = true
    throw error
  } finally {
    lease.active = false
    if (parent) owner.current = parent
    else {
      owner.closed = true
      retireClosedOwner(state)
    }
  }
}
