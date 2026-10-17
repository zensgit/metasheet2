import { createAutomationReadAuthority, type AutomationReadAuthorityOptions } from './automation-read-authority'
import { createAutomationReadLedger } from './automation-read-ledger'
import { findAutomationReadRecordCandidates } from './automation-read-record-activation'
import { captureReadScheduleOccurrence, findAutomationReadScheduleCandidates, waitForReadScheduleDbClock } from './automation-read-schedule-activation'
import { AutomationActorAuthorityError } from './automation-live-authority'
import { createAutomationReadDiscovery, type AutomationReadOptionsInput } from './automation-read-discovery'
import { createAutomationReadExecutor, type AutomationReadExecutorOptions } from './automation-read-executor'
import { createAutomationReadSourceExecution } from './automation-read-source-execution'
import { activateAutomationReadProfiles, deactivateAutomationReadProducer, renewAutomationReadProducer,
  type AutomationReadProducerIdentity, type PreparedAutomationReadProfile } from './automation-read-profiles'
import { AutomationReadLedgerError, type AutomationReadLedgerDependencies, type ReadGrantInput, type ReadTrigger,
  type ReadRecordActivationInput, type ReadRecordDelivery, type ReadScheduleActivationInput,
  type ReadScheduleOccurrence, type ReadRetryInput } from './automation-read-contracts'
import type { AutomationIntegrationActor } from './automation-live-authority'
import type { DataSourceManager } from '../data-adapters/DataSourceManager'
import { performance } from 'node:perf_hooks'

export class AutomationReadRuntimeInactive extends Error {
  readonly code = 'AUTOMATION_READ_RUNTIME_INACTIVE'
  constructor() { super('AUTOMATION_READ_RUNTIME_INACTIVE') }
}
export type AutomationReadRuntimeBinding = {
  prepareProfiles(input: { config: unknown }): readonly PreparedAutomationReadProfile[]
  codec: AutomationReadAuthorityOptions['codec']
  sourceStore: AutomationReadAuthorityOptions['sourceStore']
  preview: AutomationReadExecutorOptions['preview']
}
type StopHandle = Readonly<{ stop(): Promise<void> }>
type RuntimeDependencies = Pick<AutomationReadLedgerDependencies, 'transaction' | 'manifest'> & {
  getManager(): DataSourceManager
  enabled(): boolean
  /** Fixed diagnostic only; never pass config, producer identity or raw errors. */
  onUnavailable(): void
  onExecutionDiagnostic?: AutomationReadExecutorOptions['onExecutionDiagnostic']
}
type State = {
  closed: boolean
  controller: AbortController
  producer?: AutomationReadProducerIdentity
  executor?: ReturnType<typeof createAutomationReadExecutor>
  ledger?: ReturnType<typeof createAutomationReadLedger>
  discovery?: ReturnType<typeof createAutomationReadDiscovery>
  timer?: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  deadline?: number
  initializing?: Promise<void>
  renewing?: Promise<void>
  stopping?: Promise<void>
  runs: Set<Promise<unknown>>
}
const LEASE_MS = 60000
const RENEW_MS = 15000
// All effective limits are the minimum of these ceilings and the approved plan/grant.
const CEILING = Object.freeze({ maxRows: 10000, maxPages: 100, maxReadCount: 512, timeoutMs: 25000 })

/** Capture trusted deploy JSON now, before the plugin can mutate its context.
 * This is not tenant discovery: the real preparer still requires explicit descriptors. */
function capture(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 64) throw new AutomationReadRuntimeInactive()
  const proto = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new AutomationReadRuntimeInactive()
  seen.add(value)
  try {
    const keys = Reflect.ownKeys(value).filter(key => !Array.isArray(value) || key !== 'length')
    if (Array.isArray(value) && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) throw new AutomationReadRuntimeInactive()
    const entries = keys.map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) throw new AutomationReadRuntimeInactive()
      return [key, capture(d.value, seen, depth + 1)] as const
    })
    return Object.freeze(Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries))
  } finally { seen.delete(value) }
}

/** Server-owned singleton. Only the reviewed integration plugin receives a
 * capability. It supplies actual implementation functions, NOT a tenant claim.
 * Deployment config is captured by the host independently of request/tenant ALS.
 * No public API, automatic grants or source IO happen during activation.
 */
export function createAutomationReadRuntime(deps: RuntimeDependencies) {
  let active: State | undefined
  let capabilityGeneration = 0
  let recordAdmissionsClosed = false
  const recordAdmissions = new Set<Promise<void>>()
  let scheduleAdmissionsClosed = false
  const scheduleAdmissions = new Set<Promise<void>>()
  const scheduleAdmissionLifetime = new AbortController()
  const scheduleAdmissionControllers = new Set<AbortController>()
  // At most one listener per shared source, even when 100 admitted callbacks
  // share their caller or plugin lifetime. Entries disappear with the last run.
  const scheduleSignalSubscriptions = new Map<AbortSignal, { controllers: Set<AbortController>; abort: () => void }>()
  function subscribeScheduleSignal(source: AbortSignal, controller: AbortController): () => void {
    if (source.aborted) { controller.abort(); return () => {} }
    let subscription = scheduleSignalSubscriptions.get(source)
    if (!subscription) {
      const controllers = new Set<AbortController>()
      subscription = { controllers, abort: () => { for (const admitted of controllers) admitted.abort() } }
      scheduleSignalSubscriptions.set(source, subscription)
      source.addEventListener('abort', subscription.abort, { once: true })
    }
    subscription.controllers.add(controller)
    if (source.aborted) subscription.abort()
    const registered = subscription
    return () => {
      registered.controllers.delete(controller)
      if (registered.controllers.size === 0) {
        source.removeEventListener('abort', registered.abort)
        scheduleSignalSubscriptions.delete(source)
      }
    }
  }
  function diagnostic() { try { deps.onUnavailable() } catch { /* diagnostics cannot reopen admission */ } }
  function close(state: State) {
    state.closed = true
    if (state.timer) clearTimeout(state.timer)
    if (state.expiryTimer) clearTimeout(state.expiryTimer)
    state.timer = undefined
    state.expiryTimer = undefined
    state.controller.abort()
  }
  function stop(state: State): Promise<void> {
    // Must run BEFORE the first await: PluginLoader's legacy unload is not draining.
    close(state)
    if (state.stopping) return state.stopping
    state.stopping = (async () => {
      await state.initializing?.catch(() => {})
      await state.renewing?.catch(() => {})
      await Promise.allSettled([...state.runs])
      await state.executor?.drainPendingWork()
      try {
        if (state.producer) await deps.transaction(trx => deactivateAutomationReadProducer(trx, state.producer!))
      } catch {
        // Local admission is already closed. The DB slot expires; never force-steal.
        diagnostic()
      } finally { if (active === state) active = undefined }
    })()
    return state.stopping
  }
  function live(state: State): boolean {
    if (state.closed) return false
    if (state.deadline === undefined || performance.now() >= state.deadline) { close(state); diagnostic(); return false }
    return true
  }
  function lifetime(state: State, started: number) {
    if (state.closed) return
    state.deadline = started + LEASE_MS
    if (state.expiryTimer) clearTimeout(state.expiryTimer)
    const remaining = state.deadline - performance.now()
    if (remaining <= 0) { close(state); diagnostic(); return }
    state.expiryTimer = setTimeout(() => { close(state); diagnostic() }, Math.ceil(remaining))
    state.expiryTimer.unref?.()
  }
  function schedule(state: State, delay = RENEW_MS) {
    if (state.closed) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.renewing = (async () => {
        if (!live(state) || !deps.enabled() || !state.producer) throw new AutomationReadRuntimeInactive()
        const started = performance.now()
        await deps.transaction(trx => renewAutomationReadProducer(trx, state.producer!, LEASE_MS))
        // A delayed timer or SQL receipt cannot reopen an expired local lifetime.
        if (live(state)) { lifetime(state, started); schedule(state) }
      })().catch(() => {
        // Authority reads hold SHARE locks on this slot. Retry NOWAIT conflicts
        // (or transient DB failures) only inside the last proved lifetime. A
        // separate deadline timer closes admission even when renewal hangs.
        diagnostic()
        if (live(state) && deps.enabled()) schedule(state, 1000)
        else close(state)
      })
    }, delay)
    state.timer.unref?.()
  }
  function controlForState<T>(state: State | undefined, work: (ledger: ReturnType<typeof createAutomationReadLedger>, discovery: ReturnType<typeof createAutomationReadDiscovery>, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!state || state !== active || !live(state) || !state.ledger || !state.discovery || !deps.enabled()) return Promise.reject(new AutomationReadRuntimeInactive())
    // Control transactions also hold producer locks. Drain them before retiring
    // the slot/closing the pool, not only source executions.
    const run = work(state.ledger, state.discovery, state.controller.signal).finally(() => { state.runs.delete(run) })
    state.runs.add(run)
    return run
  }
  function control<T>(work: (ledger: ReturnType<typeof createAutomationReadLedger>, discovery: ReturnType<typeof createAutomationReadDiscovery>, signal: AbortSignal) => Promise<T>): Promise<T> {
    return controlForState(active, work)
  }
  return Object.freeze({
    createPluginCapability(deploymentConfig: unknown) {
      const config = capture(deploymentConfig)
      const generation = ++capabilityGeneration
      let used = false
      return Object.freeze({
        async activate(binding: AutomationReadRuntimeBinding): Promise<StopHandle> {
          if (used || generation !== capabilityGeneration || active) throw new AutomationReadRuntimeInactive()
          used = true
          const prepared = binding.prepareProfiles({ config })
          if (prepared.length === 0) return Object.freeze({ async stop() {} })
          if (!deps.enabled()) throw new AutomationReadRuntimeInactive()
          // Copy function references before asynchronous profile persistence.
          const { codec, sourceStore, preview } = binding
          const state: State = { closed: false, controller: new AbortController(), runs: new Set() }
          active = state
          state.initializing = (async () => {
            lifetime(state, performance.now())
            const registration = await deps.transaction(trx => activateAutomationReadProfiles(trx, prepared, LEASE_MS))
            state.producer = registration.producer
            if (!live(state) || generation !== capabilityGeneration || !deps.enabled()) throw new AutomationReadRuntimeInactive()
            const authority = createAutomationReadAuthority({ producer: registration.producer, codec, sourceStore, budgetCeiling: CEILING })
            const ledger = createAutomationReadLedger({ transaction: deps.transaction, manifest: deps.manifest, authority })
            state.ledger = ledger
            state.discovery = createAutomationReadDiscovery({ transaction: deps.transaction, authority, producer: registration.producer })
            state.executor = createAutomationReadExecutor({ ledger, authority, transaction: deps.transaction,
              sourceExecution: createAutomationReadSourceExecution(deps.getManager), preview,
              onExecutionDiagnostic: deps.onExecutionDiagnostic })
            schedule(state)
          })()
          try { await state.initializing }
          catch { await stop(state); throw new AutomationReadRuntimeInactive() }
          return Object.freeze({ stop: () => stop(state) })
        },
      })
    },
    // Host-private owner entry points; no route is installed by this factory.
    // The ledger independently proves actual actor/admin/owner in its transaction.
    grant(actor: AutomationIntegrationActor, input: ReadGrantInput) {
      return control(ledger => ledger.grant(actor, input))
    },
    activateRecord(actor: AutomationIntegrationActor, input: ReadRecordActivationInput) {
      return control(ledger => ledger.activateRecord(actor, input))
    },
    activateSchedule(actor: AutomationIntegrationActor, input: ReadScheduleActivationInput) {
      return control((ledger, _discovery, signal) => ledger.activateSchedule(actor, input, signal))
    },
    produceSchedule(occurrence: ReadScheduleOccurrence, signal: AbortSignal): Promise<void> {
      if (scheduleAdmissionsClosed) return Promise.reject(new AutomationReadRuntimeInactive())
      if (scheduleAdmissionControllers.size >= 100) return Promise.reject(new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE'))
      let planned: Readonly<ReadScheduleOccurrence>
      try {
        planned = captureReadScheduleOccurrence(occurrence)
        if (!(signal instanceof AbortSignal)) throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID')
      } catch (error) { return Promise.reject(error) }
      const state = active, controller = new AbortController()
      const signals = [...new Set([signal, scheduleAdmissionLifetime.signal, ...(state ? [state.controller.signal] : [])])]
      const unsubscribe = signals.map(source => subscribeScheduleSignal(source, controller))
      scheduleAdmissionControllers.add(controller)
      const current = () => { if (controller.signal.aborted) throw new AutomationReadRuntimeInactive() }
      const run = (async () => {
        // The scheduler provides a planned instant, never authority. This is
        // metadata-only until a fresh, explicit schedule activation is found.
        current()
        await waitForReadScheduleDbClock(deps.transaction, planned, controller.signal)
        current()
        const candidates = await findAutomationReadScheduleCandidates(deps.transaction, planned, controller.signal)
        current()
        for (const activationId of candidates) {
          current()
          try { await controlForState(state, async ledger => {
            current()
            if (planned.triggerType !== 'schedule.date_field') {
              await ledger.submitSchedule(activationId, planned, controller.signal)
              return
            }
            // Each page is an independent current-authority transaction. Earlier
            // pages remain committed if a later page fails; never claim complete
            // enumeration after hitting the bounded scan budget.
            let afterId: string | undefined
            for (let page = 0; page < 100; page++) {
              current()
              const result = await ledger.submitDateSchedulePage(activationId, planned,
                { ...(afterId === undefined ? {} : { afterId }), limit: 100 }, controller.signal)
              current()
              if (result.budgetExhausted) return
              if (result.nextCursor === null) return
              if (result.nextCursor === afterId) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
              afterId = result.nextCursor
            }
            throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
          }) }
          catch (error) {
            if (error instanceof AutomationReadLedgerError
              && ['AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED'].includes(error.code)) continue
            if (error instanceof AutomationActorAuthorityError && error.code === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') continue
            // Existing cron has no catch-up/retry before enqueue. Surface the
            // failure; never claim an unavailable callback was admitted.
            throw error
          }
        }
      })().finally(() => {
        for (const release of unsubscribe) release()
        scheduleAdmissionControllers.delete(controller)
        scheduleAdmissions.delete(run)
        state?.runs.delete(run)
      })
      scheduleAdmissions.add(run)
      state?.runs.add(run)
      return run
    },
    async stopScheduleAdmissions(): Promise<void> {
      scheduleAdmissionsClosed = true
      scheduleAdmissionLifetime.abort()
      await Promise.allSettled([...scheduleAdmissions])
    },
    produceRecord(delivery: ReadRecordDelivery, signal: AbortSignal): Promise<void> {
      if (recordAdmissionsClosed) return Promise.reject(new AutomationReadRuntimeInactive())
      const run = (async () => {
        // Metadata-only discovery remains usable with no integration runtime. No
        // activation means ordinary record events must not acquire a dependency
        // on an unconfigured plugin. Every candidate is rechecked IN its enqueue
        // transaction; these identifiers are not execution authority.
        const candidates = await findAutomationReadRecordCandidates(deps.transaction, delivery, signal)
        for (const activationId of candidates) {
          if (signal.aborted) throw new AutomationReadRuntimeInactive()
          try { await control(ledger => ledger.submitRecord(activationId, delivery, signal)) }
          catch (error) {
            // A revoked/stale/used-up authorization cannot authorize a read, nor
            // poison independent ordinary rules. Outages/locks/inactive runtime
            // MUST propagate for transport retry, never become a false ACK.
            if (error instanceof AutomationReadLedgerError
              && ['AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED'].includes(error.code)) continue
            if (error instanceof AutomationActorAuthorityError && error.code === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') continue
            throw error
          }
        }
      })().finally(() => { recordAdmissions.delete(run) })
      recordAdmissions.add(run)
      return run
    },
    async stopRecordAdmissions(): Promise<void> {
      // Server shutdown, NOT plugin unload: even metadata-only/no-runtime
      // admissions must drain before their shared pool can be closed.
      recordAdmissionsClosed = true
      await Promise.allSettled([...recordAdmissions])
    },
    options(actor: AutomationIntegrationActor, input: AutomationReadOptionsInput) {
      return control((_ledger, discovery) => discovery.options(actor, input))
    },
    submit(actor: AutomationIntegrationActor, input: { grantId: string; invocationId: string; projectNo: string; trigger: ReadTrigger }) {
      return control(ledger => ledger.submit(actor, input))
    },
    retry(actor: AutomationIntegrationActor, parentRequestId: string, input: ReadRetryInput) {
      return control((ledger, _discovery, signal) => ledger.retry(actor, parentRequestId, input, signal))
    },
    execute(requestId: string, signal: AbortSignal) {
      const state = active
      if (!state || !live(state) || !state.executor || !deps.enabled() || !(signal instanceof AbortSignal) || signal.aborted) {
        return Promise.reject(new AutomationReadRuntimeInactive())
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      state.controller.signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || state.controller.signal.aborted) abort()
      const run = state.executor.execute(requestId, controller.signal).finally(() => {
        signal.removeEventListener('abort', abort)
        state.controller.signal.removeEventListener('abort', abort)
        state.runs.delete(run)
      })
      state.runs.add(run)
      return run
    },
    stop(): Promise<void> {
      capabilityGeneration++
      return active ? stop(active) : Promise.resolve()
    },
  })
}
