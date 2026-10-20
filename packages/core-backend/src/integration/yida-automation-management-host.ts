import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { types } from 'node:util'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { createYidaAutomationAuthorizationService, YidaAutomationManagementError } from './yida-automation-authorization-service'
import { createYidaAutomationAuthorizationStore } from './yida-automation-authorization-store'
import { checkedYidaAutomationAuthorization, checkedYidaAutomationRequest } from './yida-automation-authorization-contracts'
import type { createAutomationReadRuntime } from './automation-read-runtime'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type { YidaAutomationHttpPort } from '../routes/integration-yida-automation'
import { createYidaAutomationSendRuntime, YidaAutomationRuntimeError } from './yida-automation-send-runtime'
import { captureInternalYidaAutomationClaim } from './yida-automation-dispatch-claim'
import { YIDA_AUTOMATION_CONSUMER } from './yida-automation-outbox'
import type { ConsumerAdapter, AdapterOutcome } from '../multitable/automation-durable-dispatch-loop'
import { checkedYidaIntervalOccurrence } from './yida-automation-authoring-policy'
import type { createYidaAutomationInstalledBindingSource } from './yida-automation-installed-binding'

type Primitives = Parameters<typeof createYidaAutomationAuthorizationService>[0]['primitives']
type SendDependencies = Parameters<typeof createYidaAutomationSendRuntime>[0]
type Sender = ReturnType<typeof createYidaAutomationSendRuntime>
type InstalledSource = ReturnType<typeof createYidaAutomationInstalledBindingSource>
export type YidaAutomationManagementBinding = Readonly<{
  createPrimitives(actor: Readonly<AutomationIntegrationActor>): Primitives
  createExecutionPrimitives(input: Readonly<{ grantor: Readonly<AutomationIntegrationActor>; workerId: string }>): SendDependencies['primitives']
  createAttempt: SendDependencies['createAttempt']
}>
type Dependencies = {
  database: { transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> }
  readRuntime: Pick<ReturnType<typeof createAutomationReadRuntime>, 'withInstalledBindingSourceForYida'>
  security: SendDependencies['security']; fetch: typeof fetch
  deliveryReady(): boolean
  readEnablement?: () => unknown
  timeoutMs?: number
  monotonicNow?: () => number
}
type State = { closed: boolean; activationId: string; createPrimitives: YidaAutomationManagementBinding['createPrimitives'];
  createExecutionPrimitives: YidaAutomationManagementBinding['createExecutionPrimitives']; createAttempt: SendDependencies['createAttempt'];
  controller: AbortController; executions: Set<Sender>; deliveryKeys: Set<string>; stopFailed: boolean;
  runs: Set<Promise<unknown>>; managers: Set<ReturnType<typeof createYidaAutomationAuthorizationService>>;
  slots: Map<string, Readonly<{ grantor: Readonly<AutomationIntegrationActor>; grantId: string; confirmationId: string }>>;
  pendingSlots: Set<string>; draining?: Promise<void> }
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
function fail(code: 'INPUT' | 'DENIED' | 'CLOSED' = 'DENIED'): never { throw new YidaAutomationManagementError(code) }
function actor(value: unknown): Readonly<AutomationIntegrationActor> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value), properties = Object.getOwnPropertyDescriptors(value)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(properties).length !== 3) fail('INPUT')
  for (const key of ['actorId', 'tenantId', 'workspaceId']) {
    const d = properties[key]
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('INPUT')
    if (key === 'workspaceId' ? d.value !== null : typeof d.value !== 'string' || !d.value
      || d.value.length > 128 || d.value.trim() !== d.value || /[\u0000-\u001f\u007f]/u.test(d.value)) fail('INPUT')
  }
  return Object.freeze({ actorId: properties.actorId.value as string, tenantId: properties.tenantId.value as string, workspaceId: null })
}
function requestSignal(options: unknown): AbortSignal {
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail('INPUT')
  const d = Object.getOwnPropertyDescriptors(options)
  if (Reflect.ownKeys(d).length !== 1 || !d.signal?.enumerable || !Object.hasOwn(d.signal, 'value')) fail('INPUT')
  const signal: unknown = d.signal.value
  if (!signal || typeof signal !== 'object' || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  try { aborted.call(signal) } catch { return fail('INPUT') }
  return signal as AbortSignal
}

/** Host-owned four-operation and shared-consumer composition. No scheduler or
 * standalone dispatch loop. Only the actual boot registry may publish readiness.
 * Both the entire transaction and its COMMIT response join the real producer's
 * lifetime for create/request; inspection/revocation remain available without
 * an installation but still require the genuine live owner/admin in PG.
 * No actor/binding/activation is recovered from request body or a grant DTO. */
export function createYidaAutomationManagementHost(dependencies: Dependencies) {
  const transaction: Dependencies['database']['transaction'] = dependencies.database.transaction.bind(dependencies.database)
  const withSource: Dependencies['readRuntime']['withInstalledBindingSourceForYida'] = dependencies.readRuntime.withInstalledBindingSourceForYida.bind(dependencies.readRuntime)
  const monotonicNow = dependencies.monotonicNow
  const fetcher = dependencies.fetch, security = dependencies.security
  const deliveryReady = dependencies.deliveryReady, readEnablement = dependencies.readEnablement ?? (() => 'false')
  const timeoutMs = dependencies.timeoutMs ?? 10000
  if (typeof deliveryReady !== 'function' || typeof fetcher !== 'function' || typeof readEnablement !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('INPUT')
  const serverId = randomUUID(), workerId = 'yida-automation-worker:' + randomUUID(), runs = new Set<Promise<unknown>>()
  const subscriptions = new Map<AbortSignal, { controllers: Set<AbortController>; abort(): void }>()
  // Bounded by the admitted host runs. Identity comes from the actual scoped
  // grant lookup, never from the request body or a dispatch envelope's claims.
  const grantRuns = new Map<AbortController, Readonly<{ grantId: string; grantor: Readonly<AutomationIntegrationActor> }>>()
  let active: State | undefined, terminal = false, generation = 0, terminalDrain: Promise<void> | undefined
  function check(signal: AbortSignal, state?: State) {
    if (terminal || aborted.call(signal) || state && (state.closed || active !== state)) fail('CLOSED')
  }
  function ready() { try { return deliveryReady() === true } catch { return false } }
  function sending() {
    try {
      const value: unknown = readEnablement()
      if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
        && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
      return value === 'true'
    } catch { return false }
  }
  function subscribe(source: AbortSignal, controller: AbortController) {
    let subscription = subscriptions.get(source)
    if (!subscription) {
      const controllers = new Set<AbortController>()
      subscription = { controllers, abort() { for (const child of controllers) child.abort() } }
      subscriptions.set(source, subscription)
      EventTarget.prototype.addEventListener.call(source, 'abort', subscription.abort, { once: true })
    }
    subscription.controllers.add(controller)
    if (aborted.call(source)) controller.abort()
    const captured = subscription
    return () => {
      captured.controllers.delete(controller)
      if (!captured.controllers.size) {
        EventTarget.prototype.removeEventListener.call(source, 'abort', captured.abort); subscriptions.delete(source)
      }
    }
  }
  function store(grantor: Readonly<AutomationIntegrationActor>, activationId: string) {
    return createYidaAutomationAuthorizationStore({ scope: { tenantId: grantor.tenantId, ownerId: grantor.actorId,
      workspaceId: null }, activationId, monotonicNow })
  }
  function execute<T>(input: unknown, options: unknown, installed: boolean,
    work: (trx: Queryable, grantor: Readonly<AutomationIntegrationActor>, state?: State,
      source?: InstalledSource) => Promise<T>,
    afterCommit?: (result: T, grantor: Readonly<AutomationIntegrationActor>) => void): Promise<T> {
    let grantor: Readonly<AutomationIntegrationActor>, signal: AbortSignal, state: State | undefined
    try {
      grantor = actor(input); signal = requestSignal(options); state = installed ? active : undefined
      check(signal, state)
      if (runs.size >= 32 || installed && !state) fail('CLOSED')
    } catch { return Promise.reject(new YidaAutomationManagementError('DENIED')) }
    const run = Promise.resolve().then(async () => {
      const transacted = (source?: InstalledSource) => transaction(async raw => {
        const current = () => { check(signal, state); source?.assertCurrent() }
        current()
        // Real BEGIN belongs to the host provider; no nested transaction, no
        // query races. Cancellation is checked after the ORIGINAL SQL settles.
        const trx: Queryable = Object.freeze({ async query(sql: string, values?: unknown[]) {
          current(); const result = await raw.query(sql, values); current(); return result
        } })
        await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await assertAutomationIntegrationActor(trx, grantor)
        const result = await work(trx, grantor, state, source)
        current() // Final synchronous check before the provider issues COMMIT.
        return result
      })
      const result = installed ? await withSource(source => transacted(source)) : await transacted()
      // The provider has confirmed COMMIT. Durable revocation must notify local
      // work even if its HTTP waiter disconnects while that response arrives.
      afterCommit?.(result, grantor)
      check(signal, state)
      return result
    }).catch(() => fail('DENIED')).finally(() => { runs.delete(run); state?.runs.delete(run) })
    runs.add(run); state?.runs.add(run)
    return run
  }
  async function managed<T>(trx: Queryable, grantor: Readonly<AutomationIntegrationActor>, state: State,
    source: InstalledSource, ruleId: string,
    work: (manager: ReturnType<typeof createYidaAutomationAuthorizationService>) => Promise<T>) {
    const installed = await source.resolveInTransaction(trx, grantor, ruleId)
    const manager = createYidaAutomationAuthorizationService({ grantor, ...installed,
      primitives: state.createPrimitives(grantor), activationId: state.activationId, monotonicNow,
      // One caller-owned transaction, including store/outbox, with known COMMIT
      // awaited by execute. This facade does not begin a nested transaction.
      database: { transaction: callback => callback(trx) } })
    state.managers.add(manager)
    try { return await work(manager) } finally { manager.close(); state.managers.delete(manager) }
  }
  const port: YidaAutomationHttpPort = Object.freeze({
    create(input, consent, options) {
      let captured: ReturnType<typeof checkedYidaAutomationAuthorization>
      try { captured = checkedYidaAutomationAuthorization(consent) } catch { return Promise.reject(new YidaAutomationManagementError('INPUT')) }
      const { maxTotalRows: _derived, ...raw } = captured
      const state = active, interval = captured.allowedTriggers.includes('schedule.interval')
      let approvedActor: Readonly<AutomationIntegrationActor> | undefined, signal: AbortSignal
      try { signal = requestSignal(options) } catch { return Promise.reject(new YidaAutomationManagementError('INPUT')) }
      if (interval && state) {
        const existing = state.slots.get(captured.ruleId)
        if (state.pendingSlots.has(captured.ruleId) || existing && existing.confirmationId !== captured.confirmationId
          || !existing && state.slots.size + state.pendingSlots.size >= 256) {
          return Promise.reject(new YidaAutomationManagementError('CONFLICT'))
        }
        state.pendingSlots.add(captured.ruleId)
      }
      return execute(input, options, true, (trx, grantor, currentState, source) => {
        if (currentState !== state) fail('CLOSED')
        approvedActor = grantor
        return managed(trx, grantor, state!, source!, captured.ruleId, manager => manager.create(raw))
      }).then(result => {
        check(signal, state)
        // Publish ONLY after the original COMMIT is known. A historical replay
        // never resurrects an untracked grant or replaces a current slot.
        if (interval && state && approvedActor && !result.reused) {
          state.slots.set(captured.ruleId, Object.freeze({ grantor: approvedActor,
            grantId: result.grantId, confirmationId: captured.confirmationId }))
        }
        return result
      }).finally(() => { if (interval) state?.pendingSlots.delete(captured.ruleId) })
    },
    inspect(input, grantId, options) {
      return execute(input, options, false, (trx, grantor) => store(grantor, active?.activationId ?? serverId).inspectInTransaction(trx, grantId))
    },
    revoke(input, grantId, options) {
      return execute(input, options, false, async (trx, grantor) => {
        const scoped = store(grantor, active?.activationId ?? serverId)
        await scoped.revokeInTransaction(trx, grantId)
        return (await scoped.readInTransaction(trx, grantId)).summary
      }, (result, grantor) => {
        for (const [controller, running] of grantRuns) {
          if (running.grantId === result.grantId && running.grantor.tenantId === grantor.tenantId
            && running.grantor.actorId === grantor.actorId && running.grantor.workspaceId === grantor.workspaceId) controller.abort()
        }
        if (active) for (const [ruleId, slot] of active.slots) if (slot.grantId === result.grantId) active.slots.delete(ruleId)
      })
    },
    requestManual(input, grantId, request, options) {
      let captured: Readonly<{ requestKey: string }>
      try { captured = checkedYidaAutomationRequest(request) } catch { return Promise.reject(new YidaAutomationManagementError('INPUT')) }
      return execute(input, options, true, async (trx, grantor, state, source) => {
        if (!ready()) fail('CLOSED') // Never accept a v5 request without its booted consumer.
        const saved = await store(grantor, state!.activationId).readInTransaction(trx, grantId)
        const result = await managed(trx, grantor, state!, source!, saved.consent.ruleId, manager => manager.requestManual(grantId, captured))
        if (!ready()) fail('CLOSED')
        return result
      })
    },
  })
  const retry = Object.freeze({ outcome: 'retryable_failure', reason: 'unknown' } as const)
  const reject = Object.freeze({ outcome: 'permanent_failure', reason: 'permanent_rejection' } as const)
  const adapter: ConsumerAdapter = Object.freeze({ key: YIDA_AUTOMATION_CONSUMER,
    async handle(supplied: Parameters<ConsumerAdapter['handle']>[0], options?: { signal: AbortSignal }): Promise<AdapterOutcome> {
      let claim: ReturnType<typeof captureInternalYidaAutomationClaim>, signal: AbortSignal
      try { claim = captureInternalYidaAutomationClaim(supplied); signal = requestSignal(options) } catch { return reject }
      const state = active
      if (!state || state.closed || terminal || aborted.call(signal) || !ready() || !sending()) return retry
      const key = claim.outboxId + ':' + claim.consumerKey
      if (runs.size >= 32 || state.deliveryKeys.has(key)) return retry
      const controller = new AbortController(), unsubscribe = subscribe(signal, controller)
      const stopSubscription = subscribe(state.controller.signal, controller)
      const deadline = performance.now() + timeoutMs
      const timer = setTimeout(() => controller.abort(), timeoutMs) // Includes owner/profile resolution.
      state.deliveryKeys.add(key)
      const run = Promise.resolve().then(() => withSource(async source => {
        let runtime: Sender | undefined
        const current = () => {
          check(controller.signal, state); source.assertCurrent()
          if (!ready() || !sending() || performance.now() >= deadline) fail('CLOSED')
        }
        const transacted: SendDependencies['database']['transaction'] = callback => transaction(async raw => {
          const trx: Queryable = Object.freeze({ async query(sql: string, values?: unknown[]) {
            current(); const result = await raw.query(sql, values); current(); return result
          } })
          current(); const result = await callback(trx); current(); return result
        })
        try {
          current()
          // A CLAIM envelope is only a hint. Derive the resource owner/tenant
          // from immutable server grants through the original outbox link; the
          // authority below independently re-proves lease/fence/payload in PG.
          const installed = await transacted(async trx => {
            await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
            const found = await trx.query(`SELECT g.id,g.tenant_id,g.owner_id FROM integration_yida_auto_outbox_links l
              JOIN integration_yida_auto_requests r ON r.id=l.request_id AND r.grant_id=l.grant_id
              JOIN integration_yida_auto_grants g ON g.id=l.grant_id
              WHERE l.outbox_id=$1 AND l.consumer_key=$2 AND l.request_id=$3 AND g.workspace_id IS NULL`,
            [claim.outboxId, claim.consumerKey, claim.payload.requestId])
            if (found.rows.length !== 1) fail()
            const row = found.rows[0]
            const grantor = actor({ actorId: row.owner_id, tenantId: row.tenant_id, workspaceId: null })
            await assertAutomationIntegrationActor(trx, grantor)
            const grant = await store(grantor, state.activationId).readInTransaction(trx, row.id as string)
            const binding = await source.resolveInTransaction(trx, grantor, grant.consent.ruleId)
            return Object.freeze({ grantId: grant.summary.grantId, grantor, ...binding })
          })
          current()
          grantRuns.set(controller, Object.freeze({ grantId: installed.grantId, grantor: installed.grantor }))
          runtime = createYidaAutomationSendRuntime({ ...installed,
            primitives: state.createExecutionPrimitives({ grantor: installed.grantor, workerId }),
            database: { transaction: transacted }, security, fetch: fetcher,
            activationId: state.activationId, workerId, timeoutMs, monotonicNow,
            createAttempt: state.createAttempt, readEnablement: () => { current(); return readEnablement() } })
          state.executions.add(runtime)
          return await runtime.adapter.handle(claim, { signal: controller.signal })
        } finally {
          if (runtime) {
            try { await runtime.stop() } catch { state.stopFailed = true; throw new YidaAutomationRuntimeError('STOP_FAILED') }
            finally { state.executions.delete(runtime) }
          }
        }
      })).catch(() => state.stopFailed ? reject : retry).finally(() => {
        grantRuns.delete(controller)
        clearTimeout(timer); controller.abort(); unsubscribe(); stopSubscription()
        state.deliveryKeys.delete(key); state.runs.delete(run); runs.delete(run)
      })
      runs.add(run); state.runs.add(run)
      return run
    },
  })
  function drain(state: State): Promise<void> {
    state.closed = true; state.slots.clear(); state.controller.abort(); state.managers.forEach(manager => manager.close())
    if (!state.draining) state.draining = (async () => {
      const stops = [...state.executions].map(runtime => runtime.stop().catch(() => { state.stopFailed = true }))
      try {
        await Promise.allSettled([...state.runs, ...stops])
        if (state.stopFailed) throw new YidaAutomationRuntimeError('STOP_FAILED')
      } finally { if (active === state) active = undefined }
    })()
    return state.draining
  }
  return Object.freeze({ port, adapter,
    async produceSchedule(input: unknown, signal: AbortSignal): Promise<void> {
      let occurrence: ReturnType<typeof checkedYidaIntervalOccurrence>
      try { occurrence = checkedYidaIntervalOccurrence(input) } catch { return fail('INPUT') }
      const state = active, slot = state?.slots.get(occurrence.ruleId)
      if (!state || !slot) return // No explicit consent in THIS activation.
      const controller = new AbortController(), unsubscribe = subscribe(requestSignal({ signal }), controller)
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        await execute(slot.grantor, { signal: controller.signal }, true, async (trx, grantor, currentState, source) => {
          if (state !== currentState || state.slots.get(occurrence.ruleId) !== slot || !ready()) fail('CLOSED')
          await managed(trx, grantor, state, source!, occurrence.ruleId, manager => manager.requestInterval(slot.grantId, occurrence))
          if (!ready() || state.slots.get(occurrence.ruleId) !== slot) fail('CLOSED')
        })
      } finally { clearTimeout(timer); controller.abort(); unsubscribe() }
    },
    createPluginCapability() {
      const minted = ++generation
      let used = false
      return Object.freeze({ async activate(binding: YidaAutomationManagementBinding) {
        if (terminal || used || minted !== generation) fail('CLOSED')
        used = true
        if (!binding || typeof binding !== 'object' || types.isProxy(binding)) fail('INPUT')
        function method<K extends keyof YidaAutomationManagementBinding>(key: K): YidaAutomationManagementBinding[K] {
          const descriptor = Object.getOwnPropertyDescriptor(binding, key)
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) fail('INPUT')
          return descriptor.value.bind(binding) as YidaAutomationManagementBinding[K]
        }
        const factory = method('createPrimitives'), createExecutionPrimitives = method('createExecutionPrimitives'), createAttempt = method('createAttempt')
        if (active) await drain(active)
        if (terminal || minted !== generation) fail('CLOSED')
        const state: State = { closed: false, activationId: randomUUID(), createPrimitives: factory, createExecutionPrimitives, createAttempt,
          controller: new AbortController(), executions: new Set(), deliveryKeys: new Set(), stopFailed: false, runs: new Set(), managers: new Set(),
          slots: new Map(), pendingSlots: new Set() }
        active = state
        return Object.freeze({ stop: () => drain(state) })
      } })
    },
    deactivate() { ++generation; return active ? drain(active) : Promise.resolve() },
    stop() {
      if (!terminalDrain) {
        terminal = true; ++generation
        const registration = active ? drain(active) : Promise.resolve()
        terminalDrain = (async () => { await Promise.allSettled([...runs, registration]); await registration })()
      }
      return terminalDrain
    },
  })
}
