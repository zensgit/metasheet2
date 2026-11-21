/**
 * Reconnection after a refusal by the realtime server: transient refusals are retried with capped
 * backoff, final ones are not retried, and nothing is done for failures the transport library
 * already handles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SERVER_DISCONNECT_REASON,
  SESSION_ENDED_EVENT,
  classifyConnectError,
  classifyDisconnect,
  createReconnectBackoff,
  installRealtimeReconnect,
  readRefusalNotice,
} from '../src/utils/realtimeReconnect'

type Handler = (...args: any[]) => void

function fakeSocket() {
  const handlers = new Map<string, Handler[]>()
  const socket = {
    active: false as boolean | undefined,
    connect: vi.fn(),
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return socket
    },
    fire(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    events: () => [...handlers.keys()].sort(),
  }
  return socket
}

const TRANSIENT = { code: 'REALTIME_UNAVAILABLE', retry: true }
const FINAL = { code: 'SESSION_NOT_CURRENT', retry: false }
const refusal = (data?: unknown) => Object.assign(new Error('refused'), data === undefined ? {} : { data })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('what the server said', () => {
  it('reads code and retry, and nothing from anything else', () => {
    expect(readRefusalNotice(TRANSIENT)).toEqual(TRANSIENT)
    expect(readRefusalNotice(FINAL)).toEqual(FINAL)
    expect(readRefusalNotice({ retry: true })).toEqual({ code: '', retry: true })
    for (const other of [null, undefined, 'x', 1, {}, { code: 'X' }, { retry: 'true' }, { retry: 1 }]) expect(readRefusalNotice(other)).toBeNull()
  })

  it('a disconnect is a refusal only when the server made it; it is final only when the server said so first', () => {
    expect(classifyDisconnect(SERVER_DISCONNECT_REASON, TRANSIENT)).toBe('transient')
    expect(classifyDisconnect(SERVER_DISCONNECT_REASON, null)).toBe('transient')
    expect(classifyDisconnect(SERVER_DISCONNECT_REASON, FINAL)).toBe('final')
    for (const reason of ['io client disconnect', 'transport close', 'transport error', 'ping timeout', 'parse error', undefined]) {
      expect(classifyDisconnect(reason, FINAL)).toBe('none')
      expect(classifyDisconnect(reason, TRANSIENT)).toBe('none')
    }
  })

  it('a failed handshake is retried only when the server says retry; an unmarked one is left alone', () => {
    expect(classifyConnectError(refusal(TRANSIENT), false)).toBe('transient')
    expect(classifyConnectError(refusal(TRANSIENT), undefined)).toBe('transient')
    expect(classifyConnectError(refusal(FINAL), false)).toBe('final')
    expect(classifyConnectError(refusal(), false)).toBe('none')
    expect(classifyConnectError(new Error('UNAUTHENTICATED: invalid token'), false)).toBe('none')
    expect(classifyConnectError(null, false)).toBe('none')
    // The transport library is still trying by itself: nothing to do here, whatever the error carries.
    expect(classifyConnectError(refusal(TRANSIENT), true)).toBe('none')
    expect(classifyConnectError(new Error('websocket error'), true)).toBe('none')
  })
})

describe('backoff', () => {
  it('doubles from the minimum to the cap and starts over after a reset', () => {
    const backoff = createReconnectBackoff({ minDelayMs: 1000, maxDelayMs: 30000, random: () => 1 })
    expect([1, 2, 3, 4, 5, 6, 7].map(() => backoff.next())).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(backoff.attempts).toBe(7)
    backoff.reset()
    expect(backoff.attempts).toBe(0)
    expect(backoff.next()).toBe(1000)
  })

  it('spreads each delay over the upper half of its step, never above it and never zero', () => {
    const low = createReconnectBackoff({ minDelayMs: 1000, maxDelayMs: 30000, random: () => 0 })
    expect([1, 2, 3].map(() => low.next())).toEqual([500, 1000, 2000])
    const real = createReconnectBackoff({ minDelayMs: 1000, maxDelayMs: 8000 })
    for (const step of [1000, 2000, 4000, 8000, 8000, 8000]) {
      const delay = real.next()
      expect(delay).toBeGreaterThanOrEqual(step / 2)
      expect(delay).toBeLessThanOrEqual(step)
    }
  })

  it('does not overflow after very many attempts', () => {
    const backoff = createReconnectBackoff({ minDelayMs: 1000, maxDelayMs: 30000, random: () => 1 })
    for (let index = 0; index < 5000; index += 1) backoff.next()
    expect(backoff.next()).toBe(30000)
  })
})

describe('a socket with the behaviour installed', () => {
  const options = { minDelayMs: 1000, maxDelayMs: 4000, random: () => 1 }

  it('listens to the four lifecycle events and to nothing else', () => {
    const socket = fakeSocket()
    installRealtimeReconnect(socket, options)
    expect(socket.events()).toEqual(['connect', 'connect_error', 'disconnect', SESSION_ENDED_EVENT].sort())
  })

  it('the server ends the connection as transient: it reconnects after the backoff, not before', () => {
    const socket = fakeSocket()
    const handle = installRealtimeReconnect(socket, options)
    socket.fire('connect')
    socket.fire(SESSION_ENDED_EVENT, TRANSIENT)
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    expect(handle.waiting).toBe(true)
    vi.advanceTimersByTime(999)
    expect(socket.connect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(socket.connect).toHaveBeenCalledTimes(1)
    expect(handle.waiting).toBe(false)
    expect(handle.final).toBe(false)
  })

  it('the server ends the connection for good: it never reconnects', () => {
    const socket = fakeSocket()
    const onFinal = vi.fn()
    const handle = installRealtimeReconnect(socket, { ...options, onFinal })
    socket.fire('connect')
    socket.fire(SESSION_ENDED_EVENT, FINAL)
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    vi.advanceTimersByTime(600_000)
    expect(socket.connect).not.toHaveBeenCalled()
    expect(handle.final).toBe(true)
    expect(handle.waiting).toBe(false)
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith(FINAL)
  })

  it('a server close with no notice is retried; if the session really ended, the next refusal says so and it stops', () => {
    const socket = fakeSocket()
    const handle = installRealtimeReconnect(socket, options)
    socket.fire('connect')
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    vi.advanceTimersByTime(1000)
    expect(socket.connect).toHaveBeenCalledTimes(1)
    socket.fire('connect_error', refusal(FINAL))
    vi.advanceTimersByTime(600_000)
    expect(socket.connect).toHaveBeenCalledTimes(1)
    expect(handle.final).toBe(true)
  })

  it('a notice belongs to the disconnect that follows it and to no later one', () => {
    const socket = fakeSocket()
    const handle = installRealtimeReconnect(socket, options)
    socket.fire('connect')
    socket.fire(SESSION_ENDED_EVENT, FINAL)
    socket.fire('connect') // a new connection: the old notice says nothing about it
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    expect(handle.final).toBe(false)
    expect(handle.waiting).toBe(true)
  })

  it('a refused handshake marked transient is retried with growing delays; a connect starts the delays over', () => {
    const socket = fakeSocket()
    installRealtimeReconnect(socket, options)
    const gaps: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      socket.fire('connect_error', refusal(TRANSIENT))
      const before = socket.connect.mock.calls.length
      let waited = 0
      while (socket.connect.mock.calls.length === before && waited < 60_000) {
        vi.advanceTimersByTime(500)
        waited += 500
      }
      gaps.push(waited)
    }
    expect(gaps).toEqual([1000, 2000, 4000, 4000])
    socket.fire('connect')
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    vi.advanceTimersByTime(1000)
    expect(socket.connect).toHaveBeenCalledTimes(5)
  })

  it('a refused handshake that is final, or that says nothing, is not retried', () => {
    for (const error of [refusal(FINAL), refusal(), new Error('UNAUTHENTICATED: token required')]) {
      const socket = fakeSocket()
      installRealtimeReconnect(socket, options)
      socket.fire('connect_error', error)
      vi.advanceTimersByTime(600_000)
      expect(socket.connect).not.toHaveBeenCalled()
    }
  })

  it('failures the transport library handles by itself are left to it', () => {
    const socket = fakeSocket()
    const handle = installRealtimeReconnect(socket, options)
    socket.fire('connect')
    for (const reason of ['transport close', 'transport error', 'ping timeout', 'io client disconnect']) socket.fire('disconnect', reason)
    socket.active = true
    socket.fire('connect_error', new Error('websocket error'))
    socket.fire('connect_error', refusal(TRANSIENT))
    vi.advanceTimersByTime(600_000)
    expect(socket.connect).not.toHaveBeenCalled()
    expect(handle.waiting).toBe(false)
  })

  it('several refusals in a row schedule one reconnect, not several', () => {
    const socket = fakeSocket()
    installRealtimeReconnect(socket, options)
    socket.fire('connect_error', refusal(TRANSIENT))
    socket.fire('connect_error', refusal(TRANSIENT))
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    vi.advanceTimersByTime(1000)
    expect(socket.connect).toHaveBeenCalledTimes(1)
  })

  it('stop cancels a scheduled reconnect and nothing reconnects afterwards', () => {
    const socket = fakeSocket()
    const handle = installRealtimeReconnect(socket, options)
    socket.fire('connect')
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    handle.stop()
    expect(handle.waiting).toBe(false)
    vi.advanceTimersByTime(600_000)
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    socket.fire('connect_error', refusal(TRANSIENT))
    vi.advanceTimersByTime(600_000)
    expect(socket.connect).not.toHaveBeenCalled()
  })

  it('tells its owner about every connect after the first, so rooms can be asked for again', () => {
    const socket = fakeSocket()
    const onReconnected = vi.fn()
    const handle = installRealtimeReconnect(socket, { ...options, onReconnected })
    socket.fire('connect')
    expect(onReconnected).not.toHaveBeenCalled()
    socket.fire('disconnect', SERVER_DISCONNECT_REASON)
    vi.advanceTimersByTime(1000)
    socket.fire('connect')
    socket.fire('disconnect', 'transport close')
    socket.fire('connect')
    expect(onReconnected).toHaveBeenCalledTimes(2)
    handle.stop()
    socket.fire('connect')
    expect(onReconnected).toHaveBeenCalledTimes(2)
  })

  it('reconnects the way its owner says when the owner says how', () => {
    const socket = fakeSocket()
    const reconnect = vi.fn()
    installRealtimeReconnect(socket, { ...options, reconnect })
    socket.fire('connect_error', refusal(TRANSIENT))
    vi.advanceTimersByTime(1000)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(socket.connect).not.toHaveBeenCalled()
  })

  it('does nothing, and does not throw, on something that is not a socket', () => {
    for (const notASocket of [null, undefined, {}, { on: 'x' }]) {
      const handle = installRealtimeReconnect(notASocket as never)
      handle.stop()
      expect(handle.final).toBe(false)
      expect(handle.waiting).toBe(false)
    }
  })
})
