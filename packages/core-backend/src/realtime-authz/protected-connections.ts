/**
 * Connections under continuous authorization.
 *
 * In protected mode every connection that presented a credential is registered here before it is
 * served. A connection is `pending` until its bound session has been read as current in the present
 * generation; only then is it `serviceable`. Registered connections are part of every sweep, so a
 * session that ends while its connection is idle is closed without waiting for traffic.
 *
 * Every receive and every delivery goes through `ensureCurrent` or `deliver`, and each of them reads
 * the committed facts again. A positive answer is used for that one boundary only.
 *
 * DELIVERY ORDER OF CHECKS. A delivery first samples the concrete connections it is for, then runs
 * the resource check of the room, then reads the session facts last, and hands the payload to the
 * transport synchronously for exactly those sampled connections that are still bound to the same
 * session, still subscribed and still in the generation that was read. A connection that joined
 * after the sample waits for the next delivery. A withheld delivery is dropped, never queued.
 */
import type { RealtimeDiagnostics } from './diagnostics'
import type { AdmitRefusal, ProtectionEvent, RealtimeProtection } from './protection'
import { bindingKey, type RealtimeSessionBinding } from './session-binding'

export const SESSION_ENDED_EVENT = 'realtime:session-ended'

export interface SessionEndedPayload {
  /** SESSION_NOT_CURRENT: do not reconnect with the same credential. REALTIME_UNAVAILABLE: retry later. */
  code: 'SESSION_NOT_CURRENT' | 'REALTIME_UNAVAILABLE'
  retry: boolean
}

/** The part of a Socket.IO socket this module uses. */
export interface ProtectedSocket {
  readonly id: string
  readonly connected: boolean
  readonly handshake: { auth?: unknown }
  emit(event: string, ...args: unknown[]): unknown
  disconnect(close?: boolean): unknown
}

export type ConnectionPhase = 'pending' | 'serviceable' | 'anonymous' | 'ended'

export type CurrentAnswer =
  | { readonly state: 'current'; readonly binding: RealtimeSessionBinding }
  | { readonly state: 'ended' }
  | { readonly state: 'unavailable' }

export interface ConnectionHooks {
  /** The connection was admitted (first time or again after a generation change). */
  onAdmitted?: (socket: ProtectedSocket, binding: RealtimeSessionBinding) => void
  /** The connection was ended by this registry; it is being disconnected. */
  onEnded?: (socket: ProtectedSocket, payload: SessionEndedPayload) => void
}

interface ConnectionState {
  socket: ProtectedSocket
  phase: ConnectionPhase
  binding: RealtimeSessionBinding | null
  /** Generation in which the binding was last read as current. */
  generation: number
  admitting: Promise<RealtimeSessionBinding | null> | null
  expiryTimer: unknown
  hooks: ConnectionHooks
  /** Accepted before protection became active; it is held, not refused, while traffic is suspended. */
  established: boolean
}

export interface DeliveryOptions {
  /**
   * Resource check of this delivery for one bound session; false withholds the payload from the
   * connections of that session and reports them through `onResourceDenied`. A check that rejects
   * could not answer: the payload is withheld from those connections and nothing else happens.
   */
  resourceCheck?: (binding: RealtimeSessionBinding, socket: ProtectedSocket) => Promise<boolean>
  onResourceDenied?: (socket: ProtectedSocket) => void
  /** Evaluated at the final handoff: is the sampled connection still subscribed to what is delivered? */
  stillSubscribed?: (socket: ProtectedSocket) => boolean
}

export interface ProtectedConnectionsDeps {
  protection: RealtimeProtection
  diagnostics: RealtimeDiagnostics
  /** Interval of the idle sweep. Scheduling plus processing must stay within the idle bound. */
  sweepIntervalMs?: number
  nowSeconds?: () => number
  setTimer?: (handler: () => void, delayMs: number) => { unref?: () => void }
  clearTimer?: (timer: unknown) => void
}

export const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 2_000
const MAX_TIMER_DELAY_MS = 2_147_000_000

function tokenOf(socket: ProtectedSocket): string | undefined {
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined
}

function endedPayload(refusal: AdmitRefusal): SessionEndedPayload {
  return refusal.kind === 'denied'
    ? { code: 'SESSION_NOT_CURRENT', retry: false }
    : { code: 'REALTIME_UNAVAILABLE', retry: true }
}

export class ProtectedConnections {
  private readonly states = new Map<ProtectedSocket, ConnectionState>()
  private readonly sweepHooks = new Set<() => Promise<void>>()
  private readonly protection: RealtimeProtection
  private readonly diagnostics: RealtimeDiagnostics
  private readonly sweepIntervalMs: number
  private readonly nowSeconds: () => number
  private readonly setTimer: (handler: () => void, delayMs: number) => { unref?: () => void }
  private readonly clearTimer: (timer: unknown) => void
  private sweepTimer: unknown = null
  private sweeping: Promise<void> | null = null
  private sweepAgain = false
  private unsubscribe: (() => void) | null = null

  constructor(deps: ProtectedConnectionsDeps) {
    this.protection = deps.protection
    this.diagnostics = deps.diagnostics
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS
    this.nowSeconds = deps.nowSeconds ?? (() => Date.now() / 1000)
    this.setTimer = deps.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    this.unsubscribe = this.protection.subscribe((event) => this.onProtectionEvent(event))
    this.syncSweepTimer()
  }

  /** Stops timers and forgets every connection without closing it (process shutdown, tests). */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.sweepTimer) this.clearTimer(this.sweepTimer)
    this.sweepTimer = null
    for (const state of this.states.values()) this.clearExpiry(state)
    this.states.clear()
    this.sweepHooks.clear()
  }

  /** Runs with every sweep, after the session pass: resource-level checks of idle subscriptions. */
  onSweep(hook: () => Promise<void>): void {
    this.sweepHooks.add(hook)
  }

  size(): number {
    return this.states.size
  }

  phaseOf(socket: ProtectedSocket): ConnectionPhase | undefined {
    return this.states.get(socket)?.phase
  }

  bindingOf(socket: ProtectedSocket): RealtimeSessionBinding | null {
    const state = this.states.get(socket)
    return state && state.phase === 'serviceable' ? state.binding : null
  }

  /** True when the connection may be sampled for a delivery in the present generation. */
  isServiceable(socket: ProtectedSocket): boolean {
    const state = this.states.get(socket)
    return Boolean(
      state && state.phase === 'serviceable' && state.binding && socket.connected
      && state.generation === this.protection.generation(),
    )
  }

  /**
   * Registers a connection as pending. Idempotent. Nothing is served to it until it is admitted.
   * `established` marks a connection that was accepted before protection became active: while
   * established traffic is suspended it stays connected and unserved instead of being refused like
   * a new handshake, and it is admitted once traffic is re-checked again.
   */
  register(socket: ProtectedSocket, hooks: ConnectionHooks = {}, options: { established?: boolean } = {}): void {
    if (this.states.has(socket)) return
    this.states.set(socket, {
      socket, phase: 'pending', binding: null, generation: -1, admitting: null, expiryTimer: null, hooks,
      established: options.established === true,
    })
  }

  /**
   * Marks a registered connection serviceable with a binding that was just read as current for it
   * (a namespace handshake admits before the connection exists as a connected socket).
   */
  adoptAdmitted(socket: ProtectedSocket, binding: RealtimeSessionBinding, generation: number): void {
    const state = this.states.get(socket)
    if (!state || state.phase === 'ended') return
    state.binding = binding
    state.generation = generation
    state.phase = 'serviceable'
    this.armExpiry(state)
  }

  unregister(socket: ProtectedSocket): void {
    const state = this.states.get(socket)
    if (!state) return
    this.clearExpiry(state)
    this.states.delete(socket)
  }

  /**
   * Verifies the credential of a registered connection and reads its session as current. Returns
   * the binding when the connection is serviceable afterwards. A refused credential ends the
   * connection; a connection without a credential stays connected and is never served.
   */
  admit(socket: ProtectedSocket): Promise<RealtimeSessionBinding | null> {
    const state = this.states.get(socket)
    if (!state || state.phase === 'ended') return Promise.resolve(null)
    if (state.admitting) return state.admitting
    if (state.established && !state.binding && this.protection.decision().established === 'suspend') {
      return Promise.resolve(null)
    }
    state.admitting = (async () => {
      try {
        const result = await this.protection.admit(tokenOf(socket))
        if (this.states.get(socket) !== state || state.phase === 'ended') return null
        if ('refusal' in result) {
          if (result.refusal.kind === 'no-credential') {
            state.phase = 'anonymous'
            state.binding = null
            return null
          }
          this.end(socket, endedPayload(result.refusal))
          return null
        }
        if (!socket.connected) return null
        if (state.binding && bindingKey(state.binding) !== bindingKey(result.binding)) {
          // The same connection cannot change the session it is bound to.
          this.end(socket, { code: 'SESSION_NOT_CURRENT', retry: false })
          return null
        }
        state.binding = state.binding ?? result.binding
        state.generation = result.generation
        state.phase = 'serviceable'
        this.armExpiry(state)
        state.hooks.onAdmitted?.(socket, state.binding)
        return result.generation === this.protection.generation() ? state.binding : null
      } catch {
        return null
      } finally {
        state.admitting = null
      }
    })()
    return state.admitting
  }

  /**
   * The inbound boundary: reads the session of this connection again and returns its binding only
   * when it is current now. A session that is no longer current ends the connection.
   */
  async ensureCurrent(socket: ProtectedSocket): Promise<RealtimeSessionBinding | null> {
    const answer = await this.checkCurrent(socket)
    return answer.state === 'current' ? answer.binding : null
  }

  /**
   * The inbound boundary with its three outcomes kept apart:
   *   - current:     the session was read as current right now;
   *   - ended:       it is not current, or the connection never presented a credential, or it was
   *                  refused; where the connection was ended it has been told and closed;
   *   - unavailable: no answer could be had and the connection was left as it is. Nothing may be
   *                  served on this answer, and nothing about the session may be concluded from it.
   */
  async checkCurrent(socket: ProtectedSocket): Promise<CurrentAnswer> {
    const state = this.states.get(socket)
    if (!state || state.phase === 'ended' || state.phase === 'anonymous') return { state: 'ended' }
    if (state.phase === 'pending' || state.generation !== this.protection.generation() || !state.binding) {
      const admitted = await this.admit(socket)
      if (admitted) return { state: 'current', binding: admitted }
      const after = this.states.get(socket)
      if (!after || after !== state || after.phase === 'ended' || after.phase === 'anonymous') return { state: 'ended' }
      return { state: 'unavailable' }
    }
    const binding = state.binding
    const result = await this.protection.authorize([binding])
    if (this.states.get(socket) !== state || state.phase !== 'serviceable' || state.binding !== binding) return { state: 'ended' }
    const verdict = result.verdicts.get(bindingKey(binding))
    if (verdict?.state === 'denied') {
      this.end(socket, { code: 'SESSION_NOT_CURRENT', retry: false })
      return { state: 'ended' }
    }
    if (!result.serving || result.generation !== this.protection.generation() || verdict?.state !== 'allowed' || !socket.connected) {
      this.diagnostics.recordEvent('inbound-withheld')
      return { state: 'unavailable' }
    }
    return { state: 'current', binding }
  }

  /**
   * The delivery boundary. `send` is called synchronously, once, for each sampled connection whose
   * session was read as current for this delivery. Returns the number of connections served.
   */
  async deliver(
    candidates: Iterable<ProtectedSocket>,
    send: (socket: ProtectedSocket, binding: RealtimeSessionBinding) => void,
    options: DeliveryOptions = {},
  ): Promise<number> {
    const startedIn = this.protection.generation()
    const sample: Array<{ state: ConnectionState; binding: RealtimeSessionBinding }> = []
    for (const socket of candidates) {
      const state = this.states.get(socket)
      if (!state || state.phase !== 'serviceable' || !state.binding || !socket.connected) continue
      if (state.generation !== startedIn) continue
      sample.push({ state, binding: state.binding })
    }
    if (sample.length === 0) return 0

    let eligible = sample
    if (options.resourceCheck) {
      const perSubject = new Map<string, boolean | 'unknown'>()
      for (const entry of sample) {
        const key = bindingKey(entry.binding)
        if (perSubject.has(key)) continue
        let allowed: boolean | 'unknown'
        try {
          allowed = (await options.resourceCheck(entry.binding, entry.state.socket)) === true
        } catch {
          allowed = 'unknown'
        }
        perSubject.set(key, allowed)
      }
      eligible = []
      let undecided = 0
      for (const entry of sample) {
        const answer = perSubject.get(bindingKey(entry.binding))
        if (answer === true) eligible.push(entry)
        else if (answer === 'unknown') undecided += 1
        else options.onResourceDenied?.(entry.state.socket)
      }
      if (undecided > 0) this.diagnostics.recordEvent('delivery-withheld', undecided)
      if (eligible.length === 0) return 0
    }

    const result = await this.protection.authorize(eligible.map((entry) => entry.binding))
    if (!result.serving || result.generation !== startedIn || this.protection.generation() !== startedIn) {
      this.diagnostics.recordEvent('delivery-withheld', eligible.length)
      return 0
    }

    let served = 0
    let withheld = 0
    for (const entry of eligible) {
      const { state, binding } = entry
      const socket = state.socket
      const verdict = result.verdicts.get(bindingKey(binding))
      if (verdict?.state === 'denied') {
        if (this.states.get(socket) === state && state.phase !== 'ended') {
          this.end(socket, { code: 'SESSION_NOT_CURRENT', retry: false })
        }
        continue
      }
      const stillBound = this.states.get(socket) === state
        && state.phase === 'serviceable'
        && state.binding === binding
        && state.generation === startedIn
        && socket.connected
      if (verdict?.state !== 'allowed' || !stillBound || (options.stillSubscribed && !options.stillSubscribed(socket))) {
        withheld += 1
        continue
      }
      send(socket, binding)
      served += 1
    }
    if (withheld > 0) this.diagnostics.recordEvent('delivery-withheld', withheld)
    return served
  }

  /**
   * Resource pass of a sweep: runs the resource check of a room for the connections that are
   * serviceable right now and reports the ones that may no longer read it. It reads no session
   * facts — the sweep has just read them for every connection in one batch — and it sends nothing.
   */
  async sweepResources(
    candidates: Iterable<ProtectedSocket>,
    options: Required<Pick<DeliveryOptions, 'resourceCheck' | 'onResourceDenied'>>,
  ): Promise<void> {
    const startedIn = this.protection.generation()
    const sample: Array<{ state: ConnectionState; binding: RealtimeSessionBinding }> = []
    for (const socket of candidates) {
      const state = this.states.get(socket)
      if (!state || state.phase !== 'serviceable' || !state.binding || !socket.connected) continue
      if (state.generation !== startedIn) continue
      sample.push({ state, binding: state.binding })
    }
    const perSubject = new Map<string, boolean | 'unknown'>()
    for (const entry of sample) {
      const key = bindingKey(entry.binding)
      if (perSubject.has(key)) continue
      let allowed: boolean | 'unknown'
      try {
        allowed = (await options.resourceCheck(entry.binding, entry.state.socket)) === true
      } catch {
        allowed = 'unknown'
      }
      perSubject.set(key, allowed)
    }
    for (const entry of sample) {
      // Only an answered no removes a subscription; a check that could not answer changes nothing.
      if (perSubject.get(bindingKey(entry.binding)) !== false) continue
      if (this.states.get(entry.state.socket) !== entry.state || entry.state.phase !== 'serviceable') continue
      options.onResourceDenied(entry.state.socket)
    }
  }

  /** Ends a connection: tells the client why, then closes the underlying transport. */
  end(socket: ProtectedSocket, payload: SessionEndedPayload): void {
    const state = this.states.get(socket)
    if (state) {
      if (state.phase === 'ended') return
      state.phase = 'ended'
      this.clearExpiry(state)
    }
    this.diagnostics.recordEvent('connection-terminated')
    try {
      socket.emit(SESSION_ENDED_EVENT, payload)
    } catch {
      // The transport may already be gone.
    }
    try {
      state?.hooks.onEnded?.(socket, payload)
    } finally {
      try {
        socket.disconnect(true)
      } catch {
        // Already disconnected.
      }
    }
  }

  /** Ends every registered connection that presented a credential. */
  endAll(payload: SessionEndedPayload): void {
    for (const state of [...this.states.values()]) {
      if (state.phase === 'anonymous' || state.phase === 'ended') continue
      this.end(state.socket, payload)
    }
  }

  /**
   * One pass over every registered connection: sessions that are no longer current end, pending
   * connections and connections verified in an earlier generation are verified again.
   */
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true
      return this.sweeping
    }
    this.sweeping = (async () => {
      try {
        do {
          this.sweepAgain = false
          await this.sweepOnce()
        } while (this.sweepAgain)
      } finally {
        this.sweeping = null
      }
    })()
    return this.sweeping
  }

  private async sweepOnce(): Promise<void> {
    if (this.protection.mode() === 'baseline') return
    this.diagnostics.recordEvent('full-revalidation')
    const startedIn = this.protection.generation()
    const bound: ConnectionState[] = []
    const unbound: ConnectionState[] = []
    for (const state of this.states.values()) {
      if (state.phase === 'ended' || state.phase === 'anonymous') continue
      if (!state.socket.connected) continue
      if (state.binding) bound.push(state)
      else unbound.push(state)
    }
    if (bound.length > 0) {
      const result = await this.protection.authorize(bound.map((state) => state.binding as RealtimeSessionBinding))
      for (const state of bound) {
        if (this.states.get(state.socket) !== state || state.phase === 'ended' || !state.binding) continue
        const verdict = result.verdicts.get(bindingKey(state.binding))
        if (verdict?.state === 'denied') {
          this.end(state.socket, { code: 'SESSION_NOT_CURRENT', retry: false })
          continue
        }
        if (!result.serving || result.generation !== startedIn || this.protection.generation() !== startedIn) continue
        if (verdict?.state === 'allowed') {
          const wasStale = state.phase !== 'serviceable' || state.generation !== startedIn
          state.generation = startedIn
          state.phase = 'serviceable'
          if (wasStale) state.hooks.onAdmitted?.(state.socket, state.binding)
        }
      }
    }
    for (const state of unbound) await this.admit(state.socket)
    for (const hook of [...this.sweepHooks]) {
      try {
        await hook()
      } catch {
        // A failing hook must not stop the sweep of the others.
      }
    }
  }

  private onProtectionEvent(event: ProtectionEvent): void {
    if (event.type === 'invalidate') {
      void this.sweep()
      return
    }
    this.syncSweepTimer()
    if (event.decision.established === 'terminate') {
      this.endAll({ code: 'REALTIME_UNAVAILABLE', retry: true })
      return
    }
    if (event.decision.established === 'revalidate') void this.sweep()
  }

  private syncSweepTimer(): void {
    const wanted = this.protection.mode() !== 'baseline'
    if (!wanted) {
      if (this.sweepTimer) this.clearTimer(this.sweepTimer)
      this.sweepTimer = null
      return
    }
    if (this.sweepTimer) return
    const tick = (): void => {
      this.sweepTimer = null
      if (this.protection.mode() === 'baseline' || !this.unsubscribe) return
      void this.sweep().finally(() => {
        if (this.protection.mode() === 'baseline' || !this.unsubscribe || this.sweepTimer) return
        const handle = this.setTimer(tick, this.sweepIntervalMs)
        handle.unref?.()
        this.sweepTimer = handle
      })
    }
    const handle = this.setTimer(tick, this.sweepIntervalMs)
    handle.unref?.()
    this.sweepTimer = handle
  }

  private armExpiry(state: ConnectionState): void {
    this.clearExpiry(state)
    const binding = state.binding
    // An ordinary connection keeps its established behaviour at credential expiry; a strict session
    // stops at its earliest bound whether the connection is active or idle.
    if (!binding || binding.sessionClass !== 'strict' || binding.expiresAtSeconds == null) return
    const delayMs = Math.max(0, Math.min((binding.expiresAtSeconds - this.nowSeconds()) * 1000, MAX_TIMER_DELAY_MS))
    const handle = this.setTimer(() => {
      state.expiryTimer = null
      if (this.states.get(state.socket) !== state || state.phase === 'ended') return
      this.end(state.socket, { code: 'SESSION_NOT_CURRENT', retry: false })
    }, delayMs)
    handle.unref?.()
    state.expiryTimer = handle
  }

  private clearExpiry(state: ConnectionState): void {
    if (state.expiryTimer) this.clearTimer(state.expiryTimer)
    state.expiryTimer = null
  }
}
