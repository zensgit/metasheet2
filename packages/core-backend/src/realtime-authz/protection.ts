/**
 * The realtime protection runtime of one serving process.
 *
 * It holds the current admission decision (admission.ts), keeps it current by re-reading the
 * installation generations, and answers the two questions every protected boundary asks:
 *
 *   - admit(token):        may this credential open a protected connection now?
 *   - authorize(bindings): are these bound sessions current right now?
 *
 * Both are answered from the committed facts by the strict authority reader. Nothing is cached
 * between calls: a positive answer is good for the one receive or delivery it was read for.
 *
 * MODES. While the decision is the baseline row the runtime is in `baseline` mode and the realtime
 * services run their pre-existing code paths; this runtime is then not consulted on those paths.
 * In every other row the mode is `protected`: handshakes are refused or re-checked and established
 * traffic is re-checked, suspended or ended, as the decision says.
 *
 * GENERATIONS. Every change of the decision and every listener interruption advances a generation.
 * An authorization that started in one generation never releases a delivery in another: the caller
 * compares the generation it read before with the one it sees after.
 */
import {
  ADMISSION_BEFORE_FIRST_READ,
  decideRealtimeAdmission,
  type AdmissionDecision,
  type ListenerState,
} from './admission'
import type { AuthorityVerdict, RealtimeAuthorityReader } from './authority-read'
import type { RealtimeDiagnostics } from './diagnostics'
import type { RealtimeInstallationFacts } from './installation-probe'
import { readExactSwitch } from './revalidation-flag'
import { bindingKey, type RealtimeSessionBinding } from './session-binding'

export type RealtimeMode = 'baseline' | 'protected'

/** Deterministic refusals end the session for good; a transient one may be retried by the client. */
export type AdmitRefusal =
  | { readonly kind: 'no-credential' }
  | { readonly kind: 'denied'; readonly code: 'SESSION_NOT_CURRENT' }
  | { readonly kind: 'unavailable'; readonly code: 'REALTIME_UNAVAILABLE' }

export type AdmitResult =
  | { readonly ok: true; readonly binding: RealtimeSessionBinding; readonly generation: number }
  | { readonly ok: false; readonly refusal: AdmitRefusal }

export interface AuthorizeResult {
  /** Generation the read belongs to; a caller must not release anything if it has moved on. */
  readonly generation: number
  /** False when established traffic is suspended or ended: nothing may be released. */
  readonly serving: boolean
  readonly verdicts: ReadonlyMap<string, AuthorityVerdict>
}

/** Verifies signature and expiry of a session token and binds its claims; null when it does not verify. */
export type CredentialBinder = (token: string) => RealtimeSessionBinding | null

/** Scope of an invalidation notice: which connections must be re-checked right away. */
export type InvalidationScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'organization'; readonly ref: string }
  | { readonly kind: 'user'; readonly ref: string }

export interface InvalidationListenerPort {
  state(): ListenerState
  /** Opens the dedicated session and starts listening; resolves when the first attempt has settled. */
  start(): Promise<void>
  stop(): Promise<void>
  /** Called on every change of state, including an interruption and a recovery. */
  onStateChange(handler: (state: ListenerState) => void): void
  onNotice(handler: (scope: InvalidationScope) => void): void
}

/** Listener port of an instance that never listens: revalidation ON can then never become ready. */
export const noInvalidationListener: InvalidationListenerPort = {
  state: () => 'not-started',
  start: async () => undefined,
  stop: async () => undefined,
  onStateChange: () => undefined,
  onNotice: () => undefined,
}

export type ProtectionEvent =
  | { readonly type: 'decision'; readonly decision: AdmissionDecision; readonly generation: number }
  | { readonly type: 'invalidate'; readonly scope: InvalidationScope }

export interface RealtimeProtection {
  mode(): RealtimeMode
  decision(): AdmissionDecision
  generation(): number
  admit(token: string | undefined): Promise<AdmitResult>
  authorize(bindings: readonly RealtimeSessionBinding[]): Promise<AuthorizeResult>
  subscribe(handler: (event: ProtectionEvent) => void): () => void
}

export interface RealtimeProtectionDeps {
  env?: () => NodeJS.ProcessEnv
  credentialChainFlag: string
  revalidationFlag: string
  probe: () => Promise<RealtimeInstallationFacts>
  authority: RealtimeAuthorityReader
  bindCredential: CredentialBinder
  listener?: InvalidationListenerPort
  diagnostics: RealtimeDiagnostics
  /** Interval of the periodic re-read of the installation generations. */
  reprobeIntervalMs?: number
  /** First delay of the bounded backoff used while a generation cannot be decided. */
  undeterminedRetryMinMs?: number
  undeterminedRetryMaxMs?: number
  setTimer?: (handler: () => void, delayMs: number) => { unref?: () => void }
  clearTimer?: (timer: unknown) => void
}

export const DEFAULT_REPROBE_INTERVAL_MS = 30_000
export const DEFAULT_UNDETERMINED_RETRY_MIN_MS = 500
export const DEFAULT_UNDETERMINED_RETRY_MAX_MS = 5_000

export interface RealtimeProtectionRuntime extends RealtimeProtection {
  /** First read of switches and installation; starts the listener when the decision requires one. */
  start(): Promise<void>
  /** Re-reads switches and installation now and applies the resulting decision. */
  refresh(): Promise<AdmissionDecision>
  stop(): Promise<void>
}

function sameDecision(left: AdmissionDecision, right: AdmissionDecision): boolean {
  return left.row === right.row
    && left.ordinaryHandshake === right.ordinaryHandshake
    && left.strictHandshake === right.strictHandshake
    && left.established === right.established
    && left.listenerRequired === right.listenerRequired
    && left.notices.length === right.notices.length
    && left.notices.every((notice, index) => notice === right.notices[index])
}

export function createRealtimeProtection(deps: RealtimeProtectionDeps): RealtimeProtectionRuntime {
  const env = deps.env ?? (() => process.env)
  const listener = deps.listener ?? noInvalidationListener
  const setTimer = deps.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  const reprobeIntervalMs = deps.reprobeIntervalMs ?? DEFAULT_REPROBE_INTERVAL_MS
  const retryMinMs = deps.undeterminedRetryMinMs ?? DEFAULT_UNDETERMINED_RETRY_MIN_MS
  const retryMaxMs = deps.undeterminedRetryMaxMs ?? DEFAULT_UNDETERMINED_RETRY_MAX_MS

  let current: AdmissionDecision = ADMISSION_BEFORE_FIRST_READ
  let facts: RealtimeInstallationFacts | null = null
  let generation = 0
  let stopped = false
  let timer: unknown = null
  let retryDelayMs = retryMinMs
  let refreshing: Promise<AdmissionDecision> | null = null
  let listenerStarted = false
  const handlers = new Set<(event: ProtectionEvent) => void>()

  function publish(event: ProtectionEvent): void {
    for (const handler of [...handlers]) {
      try {
        handler(event)
      } catch {
        // A failing subscriber must not stop the others or the runtime.
      }
    }
  }

  function apply(next: AdmissionDecision, force = false): void {
    deps.diagnostics.recordDecision(next)
    if (!force && sameDecision(current, next)) return
    current = next
    generation += 1
    publish({ type: 'decision', decision: next, generation })
  }

  function decide(): AdmissionDecision {
    const currentEnv = env()
    return decideRealtimeAdmission({
      revalidation: readExactSwitch(currentEnv[deps.revalidationFlag]),
      credentialChain: readExactSwitch(currentEnv[deps.credentialChainFlag]),
      facts: facts ?? { strictScope: { state: 'unknown' }, enablement: { state: 'unknown' } },
      listener: listener.state(),
    })
  }

  function schedule(): void {
    if (stopped) return
    if (timer) clearTimer(timer)
    const undetermined = !facts || facts.strictScope.state === 'unknown' || facts.enablement.state === 'unknown'
    const delay = undetermined ? retryDelayMs : reprobeIntervalMs
    if (undetermined) retryDelayMs = Math.min(retryDelayMs * 2, retryMaxMs)
    else retryDelayMs = retryMinMs
    const handle = setTimer(() => {
      timer = null
      void refresh()
    }, delay)
    handle.unref?.()
    timer = handle
  }

  async function ensureListener(): Promise<void> {
    if (listenerStarted || stopped) return
    listenerStarted = true
    try {
      await listener.start()
    } catch {
      // The listener reports its own state; a failed start leaves it not ready.
    }
  }

  async function refresh(): Promise<AdmissionDecision> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        facts = await deps.probe()
        if (facts.strictScope.state === 'unknown' || facts.enablement.state === 'unknown') {
          deps.diagnostics.recordEvent('installation-probe-undetermined')
        }
        let next = decide()
        if (next.listenerRequired && !listenerStarted) {
          await ensureListener()
          next = decide()
        }
        apply(next)
        return current
      } finally {
        refreshing = null
        schedule()
      }
    })()
    return refreshing
  }

  listener.onStateChange((state) => {
    if (stopped) return
    if (state !== 'ready') deps.diagnostics.recordEvent('listener-interrupted')
    // Any change of listener state starts a new generation: connections verified before it are
    // verified again before they are served, even when the decision row comes out the same.
    apply(decide(), true)
  })
  listener.onNotice((scope) => {
    if (stopped) return
    publish({ type: 'invalidate', scope })
  })

  const unavailable: AdmitResult = Object.freeze({
    ok: false,
    refusal: Object.freeze({ kind: 'unavailable', code: 'REALTIME_UNAVAILABLE' }),
  })
  const notCurrent: AdmitResult = Object.freeze({
    ok: false,
    refusal: Object.freeze({ kind: 'denied', code: 'SESSION_NOT_CURRENT' }),
  })

  return {
    mode: () => (current.row === 'off-baseline' ? 'baseline' : 'protected'),
    decision: () => current,
    generation: () => generation,

    async admit(token) {
      if (typeof token !== 'string' || token.length === 0) return { ok: false, refusal: { kind: 'no-credential' } }
      const startedIn = generation
      const decision = current
      let binding: RealtimeSessionBinding | null
      try {
        binding = deps.bindCredential(token)
      } catch {
        binding = null
      }
      if (!binding) {
        deps.diagnostics.recordEvent('handshake-refused')
        return notCurrent
      }
      const policy = binding.sessionClass === 'strict' ? decision.strictHandshake : decision.ordinaryHandshake
      if (policy !== 'revalidate') {
        deps.diagnostics.recordEvent('handshake-refused')
        // A strict credential where no strict session can exist is a deterministic refusal; an
        // instance that is not serving protected traffic at all answers a transient one.
        return decision.established === 'revalidate' ? notCurrent : unavailable
      }
      const verdicts = await deps.authority.read([binding])
      const verdict = verdicts.get(bindingKey(binding))
      if (generation !== startedIn) {
        deps.diagnostics.recordEvent('handshake-refused')
        return unavailable
      }
      if (verdict?.state === 'allowed') return { ok: true, binding, generation: startedIn }
      deps.diagnostics.recordEvent('handshake-refused')
      if (verdict?.state === 'denied') return notCurrent
      deps.diagnostics.recordEvent('authority-read-unknown')
      return unavailable
    },

    async authorize(bindings) {
      const startedIn = generation
      if (current.established !== 'revalidate') {
        return { generation: startedIn, serving: false, verdicts: new Map() }
      }
      const verdicts = await deps.authority.read(bindings)
      let unknown = 0
      for (const verdict of verdicts.values()) if (verdict.state === 'unknown') unknown += 1
      if (unknown > 0) deps.diagnostics.recordEvent('authority-read-unknown', unknown)
      return {
        generation: startedIn,
        serving: generation === startedIn && current.established === 'revalidate',
        verdicts,
      }
    },

    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },

    async start() {
      stopped = false
      await refresh()
    },

    refresh,

    async stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      handlers.clear()
      if (listenerStarted) {
        listenerStarted = false
        try {
          await listener.stop()
        } catch {
          // Stopping is best effort; the process is going away.
        }
      }
    },
  }
}

/** A protection that is always in baseline mode: the realtime services behave exactly as before. */
export const baselineRealtimeProtection: RealtimeProtection = {
  mode: () => 'baseline',
  decision: () => ({
    row: 'off-baseline',
    ordinaryHandshake: 'baseline',
    strictHandshake: 'baseline',
    established: 'baseline',
    listenerRequired: false,
    notices: [],
  }),
  generation: () => 0,
  admit: async () => ({ ok: false, refusal: { kind: 'unavailable', code: 'REALTIME_UNAVAILABLE' } }),
  authorize: async () => ({ generation: 0, serving: false, verdicts: new Map() }),
  subscribe: () => () => undefined,
}
