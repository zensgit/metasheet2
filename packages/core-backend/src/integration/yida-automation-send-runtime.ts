import { types } from 'node:util'
import { createYidaAutomationExecutionAuthority } from './yida-automation-execution-authority'
import { captureInternalYidaAutomationClaim } from './yida-automation-dispatch-claim'
import { YIDA_AUTOMATION_CONSUMER } from './yida-automation-outbox'
import type { AdapterOutcome, ConsumerAdapter } from '../multitable/automation-durable-dispatch-loop'
import type { ClaimedConsumer } from '../multitable/automation-durable-dispatcher'

type Authority = ReturnType<typeof createYidaAutomationExecutionAuthority>
type Attempt = Readonly<{ run(options: { signal: AbortSignal }): Promise<unknown>; close(): void }>
type Dependencies = Parameters<typeof createYidaAutomationExecutionAuthority>[0] & {
  fetch: typeof fetch
  // Actual reviewed plugin constructor, captured by the host, not an event/body.
  createAttempt(options: Readonly<{ context: Readonly<{ tenantId: string; workspaceId: null; ownerId: string; actorId: string }>;
    authority: Authority; permit: object; fetch: typeof fetch; readEnablement: () => unknown; timeoutMs: number }>): Attempt
}
type Run = { controller: AbortController; pending: Promise<AdapterOutcome> }
type Row = Record<string, unknown>
const MAX_RUNS = 32
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener
const ACK = Object.freeze({ outcome: 'success' } as const)
const REJECT = Object.freeze({ outcome: 'permanent_failure', reason: 'permanent_rejection' } as const)
const NOT_STARTED = Object.freeze({ outcome: 'retryable_failure', reason: 'unknown' } as const)
export class YidaAutomationRuntimeError extends Error {
  constructor(code: 'INPUT' | 'STOP_FAILED') { super('YIDA_AUTOMATION_RUNTIME_' + code) }
}
function data(value: unknown, keys: readonly string[], required = keys): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new YidaAutomationRuntimeError('INPUT')
  const proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) throw new YidaAutomationRuntimeError('INPUT')
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new YidaAutomationRuntimeError('INPUT')
    return [key, descriptor.value]
  }))
}
function signalOf(value: unknown): AbortSignal {
  const { signal } = data(value, ['signal'])
  if (!signal || typeof signal !== 'object' || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) {
    throw new YidaAutomationRuntimeError('INPUT')
  }
  try { aborted.call(signal) } catch { throw new YidaAutomationRuntimeError('INPUT') }
  return signal as AbortSignal
}
function stopFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === 'YIDA_RUN_STOP_FAILED'
}

/** Per-installation HOST PRIVATE composition, not global registration. The host
 * supplies the trusted tenant/owner/project binding and real activation/worker.
 * It receives only a shared-loop adapter and an independently drained lifetime;
 * no JWT, default flag, producer, scheduler or HTTP route is created here. */
export function createYidaAutomationSendRuntime(dependencies: Dependencies) {
  const authority = createYidaAutomationExecutionAuthority(dependencies)
  const createAttempt = dependencies.createAttempt, fetcher = dependencies.fetch
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  const timeoutMs = dependencies.timeoutMs ?? 10000
  if (typeof createAttempt !== 'function' || types.isProxy(createAttempt) || typeof fetcher !== 'function'
    || typeof readEnablement !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) {
    authority.close(); throw new YidaAutomationRuntimeError('INPUT')
  }
  const context = Object.freeze({ tenantId: dependencies.grantor.tenantId, workspaceId: null,
    ownerId: dependencies.grantor.actorId, actorId: dependencies.workerId })
  const runs = new Map<string, Run>()
  const subscriptions = new Map<AbortSignal, { controllers: Set<AbortController>; abort(): void }>()
  let closed = false, stopFailed = false, stopSettled = false, draining: Promise<void> | undefined
  function enabled(): boolean {
    let value: unknown
    try { value = readEnablement() } catch { return false }
    // A rejected ordinary Promise is still OFF, but must be observed safely.
    try {
      if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
        && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
    } catch { /* No coercion/accessor can authorize execution. */ }
    return value === 'true'
  }
  function subscribe(source: AbortSignal, controller: AbortController): () => void {
    let subscription = subscriptions.get(source)
    if (!subscription) {
      const controllers = new Set<AbortController>()
      subscription = { controllers, abort: () => { for (const child of controllers) child.abort() } }
      subscriptions.set(source, subscription); addListener.call(source, 'abort', subscription.abort, { once: true })
    }
    subscription.controllers.add(controller)
    if (aborted.call(source)) controller.abort()
    const captured = subscription
    return () => {
      captured.controllers.delete(controller)
      if (!captured.controllers.size) {
        removeListener.call(source, 'abort', captured.abort); subscriptions.delete(source)
      }
    }
  }
  const adapter: ConsumerAdapter = Object.freeze({ key: YIDA_AUTOMATION_CONSUMER,
    async handle(input: ClaimedConsumer, options?: { signal: AbortSignal }): Promise<AdapterOutcome> {
      let claim: ReturnType<typeof captureInternalYidaAutomationClaim>, source: AbortSignal
      try { claim = captureInternalYidaAutomationClaim(input); source = signalOf(options) }
      catch { return REJECT }
      if (closed || !enabled() || aborted.call(source)) return NOT_STARTED
      // Fence changes do not make concurrent work for the SAME request safe.
      // A replay never joins an old promise and mislabels it as its own outcome.
      const key = claim.outboxId + ':' + claim.consumerKey
      if (runs.has(key) || runs.size >= MAX_RUNS) return NOT_STARTED
      const controller = new AbortController(), unsubscribe = subscribe(source, controller)
      const timer = setTimeout(() => controller.abort(), timeoutMs) // Starts BEFORE admission/DB waits.
      const current = () => {
        if (closed || !enabled() || aborted.call(controller.signal)) throw new YidaAutomationRuntimeError('INPUT')
      }
      const run: Run = { controller, pending: undefined! }
      runs.set(key, run)
      run.pending = Promise.resolve().then(async (): Promise<AdapterOutcome> => {
        let attempt: Attempt | undefined
        let enteredAttempt = false
        try {
          current()
          const admitted = await authority.admitForExecution(claim, { signal: controller.signal })
          current()
          if (admitted.approval.reused) {
            if (admitted.permit !== null) return REJECT
            const { grantId, requestId, admissionId, ledgerId } = admitted.approval
            const history = await authority.observeAdmission({ grantId, requestId, admissionId, ledgerId })
            current()
            return history.status === 'acknowledged' ? ACK : REJECT // Never recover a second sender.
          }
          if (admitted.permit === null) return REJECT
          enteredAttempt = true // Set BEFORE calling a plugin constructor, including a throwing one.
          attempt = createAttempt(Object.freeze({ context, authority, permit: admitted.permit,
            fetch: fetcher, readEnablement, timeoutMs }))
          current()
          if (!attempt || typeof attempt.run !== 'function' || typeof attempt.close !== 'function') return REJECT
          const result = data(await attempt.run({ signal: controller.signal }),
            ['status', 'durable', 'externalWriteAttempted', 'businessVerified', 'record'])
          return result.status === 'acknowledged' && result.durable === true
            && result.businessVerified === false && result.externalWriteAttempted === true ? ACK : REJECT
        } catch (error) {
          if (stopFailure(error)) stopFailed = true
          // Pre-constructor transport retry is METADATA ONLY: if admission's
          // COMMIT was unknown, replay receives history/no permit, never a new
          // sender. Once the attempt boundary was entered, no generic retry.
          return enteredAttempt ? REJECT : NOT_STARTED
        } finally {
          try { attempt?.close() } catch { stopFailed = true }
          clearTimeout(timer); controller.abort(); unsubscribe(); runs.delete(key)
        }
      })
      return run.pending
    },
  })
  function stop(): Promise<void> {
    closed = true
    for (const run of runs.values()) run.controller.abort()
    if (!draining) draining = (async () => {
      try {
        // No timeout race: this is the original admitted work, including DB
        // COMMIT responses and the actual token flight drain inside the attempt.
        await Promise.allSettled([...runs.values()].map(run => run.pending))
        if (stopFailed) throw new YidaAutomationRuntimeError('STOP_FAILED')
      } finally { authority.close(); stopSettled = true }
    })()
    return draining
  }
  return Object.freeze({ adapter, stop,
    status: () => Object.freeze({ accepting: !closed && enabled(), activeRunCount: runs.size,
      stopPending: closed && !stopSettled, stopFailed }) })
}
