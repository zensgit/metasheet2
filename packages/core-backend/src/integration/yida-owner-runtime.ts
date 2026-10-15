import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  createInternalYidaSendExecutionAuthority,
  yidaSendApprovalErrorCode,
  type YidaSendExecutionPrimitives,
} from './yida-send-approval-service'

// Host private: authentication supplies actor, and the actual core authority
// independently proves live ACL and the permanent target owner in PostgreSQL.
// This runtime is admission/lifetime control, never an authority substitute.
export type YidaOwnerActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
type Authority = ReturnType<typeof createInternalYidaSendExecutionAuthority>
type Send = (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
export type YidaOwnerRuntimeBinding = Readonly<{
  createPrimitives(context: YidaOwnerActor): YidaSendExecutionPrimitives
  createSendPort(options: Readonly<{
    context: YidaOwnerActor; authority: Authority; fetch: typeof fetch
    readEnablement: () => unknown; timeoutMs: number
  }>): { submit: Send; inspect?(input: unknown): Promise<unknown> }
}>
export type YidaOwnerRuntimeDependencies = {
  database: { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
  security: { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
  fetch: typeof fetch
  readEnablement?: () => unknown
  timeoutMs?: number
}
export type YidaOwnerPrepareDraftInput = Readonly<{ config: unknown; rowsText: string; allocation?: unknown }>
export type YidaOwnerPreviewInput = Readonly<{ operationId: string; rowKey: string }>
export type YidaOwnerApproveInput = YidaOwnerPreviewInput & Readonly<{ confirmationId: string; ttlMs?: number }>
export type YidaOwnerGrantInput = Readonly<{ grantId: string }>
export type YidaOwnerSubmitInput = YidaOwnerGrantInput & Readonly<{ submissionId: string }>
type Code = 'INPUT' | 'DISABLED' | 'INACTIVE' | 'UNAVAILABLE' | 'CANCELLED'
const CODES = new Set<unknown>(['INPUT', 'DISABLED', 'INACTIVE', 'UNAVAILABLE', 'CANCELLED'])
const ownErrors = new WeakMap<object, Code>()
const MAX_RUNS = 32
const META = ['grantId', 'operationId', 'rowKey', 'targetRef', 'approvedAt', 'expiresAt',
  'maxAttempts', 'remainingAttempts', 'status', 'revoked', 'admissionId', 'ledgerId', 'canSend', 'externalWriteAttempted']
const DELIVERY_STATES = new Set(['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'])
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener
type Row = Record<string, unknown>
type Checked = <T>(operation: () => Promise<T>) => Promise<T>
type Run = { controller: AbortController; pending: Promise<unknown>; dependencies: Set<Promise<unknown>> }
type Registration = {
  closed: boolean; runs: Set<Run>
  createPrimitives: YidaOwnerRuntimeBinding['createPrimitives']
  createSendPort: YidaOwnerRuntimeBinding['createSendPort']
  draining?: Promise<void>
}

export class YidaOwnerRuntimeError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (CODES.has(code) ? code : 'UNAVAILABLE') as Code
    super(`YIDA_OWNER_RUNTIME_${fixed}`)
    this.name = 'YidaOwnerRuntimeError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
export function yidaOwnerRuntimeErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? yidaSendApprovalErrorCode(error) : `YIDA_OWNER_RUNTIME_${code}`
}
function fail(code: Code): never { throw new YidaOwnerRuntimeError(code) }
function closeError(error: unknown): never {
  const own = ownErrors.get(error as object)
  if (own) fail(own)
  // The core decoder consults its own WeakMap only. Never examine foreign
  // message/code/prototype/toString, including a hostile rejection Proxy.
  if (yidaSendApprovalErrorCode(error) !== undefined) throw error
  fail('UNAVAILABLE')
}
function record(value: unknown, keys: readonly string[], required = keys): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT')
  const result: Row = Object.create(null)
  for (const key of Object.keys(descriptors)) {
    const property = descriptors[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    result[key] = property.value
  }
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function actor(value: unknown): YidaOwnerActor {
  const input = record(value, ['actorId', 'tenantId', 'workspaceId'])
  if (input.workspaceId !== null) fail('INPUT')
  return Object.freeze({ actorId: id(input.actorId), tenantId: id(input.tenantId), workspaceId: null })
}
function signalOf(options: unknown): AbortSignal | undefined {
  const { signal } = record(options, ['signal'], [])
  if (signal === undefined) return undefined
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  try { abortedGetter.call(signal) } catch { fail('INPUT') }
  return signal as AbortSignal
}
function consumeRejection(value: unknown): void {
  // A rejected native promise is not enablement, but should not become an
  // unhandled rejection merely because the switch mistakenly returns it.
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* No inspection/coercion of foreign asynchronous control. */ }
}
function rejected<T>(error: unknown): Promise<T> {
  const pending = Promise.reject<T>(error)
  consumeRejection(pending)
  return pending
}
function metadata(value: unknown, grantId: string, reused: boolean): Readonly<Row> {
  const raw = record(value, reused ? [...META, 'reused'] : META)
  if (!Object.isFrozen(value) || raw.grantId !== grantId || raw.canSend !== false || raw.externalWriteAttempted !== false
    || raw.maxAttempts !== 1 || ![0, 1].includes(raw.remainingAttempts as number)
    || !['approved', 'expired', 'revoked', 'admitted'].includes(raw.status as string)
    || typeof raw.revoked !== 'boolean' || (reused && typeof raw.reused !== 'boolean')) fail('UNAVAILABLE')
  for (const key of ['grantId', 'operationId', 'rowKey', 'targetRef']) id(raw[key])
  for (const key of ['admissionId', 'ledgerId']) if (raw[key] !== null) id(raw[key])
  for (const key of ['approvedAt', 'expiresAt']) if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1) fail('UNAVAILABLE')
  return Object.freeze({ ...raw })
}
function submitView(value: unknown, grantId: string): Readonly<Row> {
  const raw = record(value, ['approval', 'delivery', 'reused', 'status', 'externalWriteAttempted', 'businessVerified', 'durable'])
  if (typeof raw.reused !== 'boolean' || typeof raw.externalWriteAttempted !== 'boolean'
    || raw.businessVerified !== false || typeof raw.durable !== 'boolean'
    || ![...DELIVERY_STATES, 'not_started', 'state_unconfirmed'].includes(raw.status as string)) fail('UNAVAILABLE')
  let delivery: Readonly<Row> | null = null
  if (raw.delivery !== null) {
    const row = record(raw.delivery, ['id', 'status', 'durable'])
    if (!DELIVERY_STATES.has(row.status as string) || row.durable !== true) fail('UNAVAILABLE')
    delivery = Object.freeze({ id: id(row.id), status: row.status, durable: true })
  }
  // Send metadata is a values-free projection. A permit, handle, token,
  // material or additional dependency field cannot escape this boundary.
  return Object.freeze({ ...raw, approval: metadata(raw.approval, grantId, false), delivery })
}

export function createYidaOwnerRuntime(dependencies: YidaOwnerRuntimeDependencies) {
  // These are trusted host dependencies, captured once with their native owner.
  const transaction: YidaOwnerRuntimeDependencies['database']['transaction'] = dependencies.database.transaction.bind(dependencies.database)
  const encrypt: YidaOwnerRuntimeDependencies['security']['encrypt'] = dependencies.security.encrypt.bind(dependencies.security)
  const decrypt: YidaOwnerRuntimeDependencies['security']['decrypt'] = dependencies.security.decrypt.bind(dependencies.security)
  const fetcher = dependencies.fetch
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  const timeoutMs = dependencies.timeoutMs ?? 10000
  if (typeof fetcher !== 'function' || typeof readEnablement !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('INPUT')
  let active: Registration | undefined, capabilityGeneration = 0, terminal = false
  let terminalDrain: Promise<void> | undefined
  const subscriptions = new WeakMap<AbortSignal, { controllers: Set<AbortController>; abort: () => void }>()

  function subscribe(source: AbortSignal, controller: AbortController): () => void {
    let subscription = subscriptions.get(source)
    if (!subscription) {
      const controllers = new Set<AbortController>()
      subscription = { controllers, abort: () => { for (const admitted of controllers) admitted.abort() } }
      subscriptions.set(source, subscription)
      addListener.call(source, 'abort', subscription.abort, { once: true })
    }
    subscription.controllers.add(controller)
    if (abortedGetter.call(source)) controller.abort()
    const captured = subscription
    return () => {
      captured.controllers.delete(controller)
      if (captured.controllers.size === 0) {
        removeListener.call(source, 'abort', captured.abort)
        subscriptions.delete(source)
      }
    }
  }

  function enabled() {
    let value: unknown
    try { value = readEnablement() } catch { fail('DISABLED') }
    if (value !== 'true') { consumeRejection(value); fail('DISABLED') }
  }
  function close(state: Registration) {
    state.closed = true
    // Native lifetime and caller-combined signals abort synchronously, before
    // drain starts. A dependency that ignores cancellation remains pending.
    for (const run of state.runs) run.controller.abort()
  }
  function drain(state: Registration): Promise<void> {
    close(state)
    if (state.draining) return state.draining
    state.draining = Promise.allSettled([...state.runs].map(run => run.pending)).then(() => {
      if (active === state) active = undefined
    })
    return state.draining
  }
  function execute<T>(inputActor: unknown, options: unknown, requiresEnablement: boolean,
    work: (authority: Authority, state: Registration, context: YidaOwnerActor, checkpoint: () => void, signal: AbortSignal, checked: Checked) => Promise<T>): Promise<T> {
    try {
      const context = actor(inputActor), caller = signalOf(options), state = active
      if (terminal || !state || state.closed) fail('INACTIVE')
      if (caller && abortedGetter.call(caller)) fail('CANCELLED')
      if (requiresEnablement) enabled()
      if (state.runs.size >= MAX_RUNS) fail('UNAVAILABLE')
      const controller = new AbortController()
      const unsubscribe = caller ? subscribe(caller, controller) : () => {}
      const checkpoint = () => {
        if (abortedGetter.call(controller.signal)) fail('CANCELLED')
        if (terminal || state.closed || state !== active) fail('INACTIVE')
        if (requiresEnablement) enabled()
      }
      async function checked<R>(operation: () => Promise<R>): Promise<R> {
        checkpoint()
        const pending = operation()
        run.dependencies.add(pending)
        try {
          const result = await pending
          checkpoint()
          return result
        } finally { run.dependencies.delete(pending) }
      }
      const database = Object.freeze({
        transaction<R>(callback: (trx: Queryable) => Promise<R>): Promise<R> {
          return checked(() => transaction(async raw => {
            checkpoint()
            // Keep raw rows AND rowCount. The plugin owns its structured db
            // adapter, and receives no nested transaction on this queryable.
            const trx: Queryable = Object.freeze({ query(sql: string, params?: unknown[]) {
              return checked(() => raw.query(sql, params))
            } })
            const result = await callback(trx)
            checkpoint()
            return result
          }))
        },
      })
      const security = Object.freeze({
        encrypt(value: string) { return checked(() => encrypt(value)) },
        decrypt(value: string) { return checked(() => decrypt(value)) },
      })
      const run: Run = { controller, pending: undefined!, dependencies: new Set() }
      state.runs.add(run)
      // Queue work only after the ORIGINAL promise is recorded. This also
      // handles a plugin factory synchronously requesting deactivation.
      run.pending = Promise.resolve().then(async () => {
        try {
          checkpoint()
          const primitives = state.createPrimitives(context)
          checkpoint()
          const authority = createInternalYidaSendExecutionAuthority({ database, security, context, primitives })
          checkpoint()
          return await checked(() => work(authority, state, context, checkpoint, controller.signal, checked))
        } catch (error) {
          // A private core/plugin boundary may already have closed a host
          // cancellation to UNAVAILABLE. Local lifetime/control takes priority
          // without reading that foreign error or pretending its work settled.
          try { checkpoint() } catch (control) { closeError(control) }
          closeError(error)
        }
        finally {
          // A token waiter can reject before its original credential/exchange
          // dependency settles. Keep the run admitted until every host call
          // actually finishes, and reject all further calls from that run.
          controller.abort()
          unsubscribe()
          while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])
          state.runs.delete(run)
          if (terminal || state.closed || state !== active || (caller && abortedGetter.call(caller))) fail('CANCELLED')
          if (requiresEnablement) enabled()
        }
      })
      consumeRejection(run.pending)
      return run.pending as Promise<T>
    } catch (error) {
      try { closeError(error) } catch (closed) { return rejected<T>(closed) }
    }
  }
  function input<T>(capture: () => T, invoke: (captured: T) => Promise<unknown>): Promise<unknown> {
    try { return invoke(capture()) }
    catch (error) {
      try { closeError(error) } catch (closed) { return rejected(closed) }
    }
  }
  return Object.freeze({
    createPluginCapability() {
      if (terminal) fail('INACTIVE')
      const generation = ++capabilityGeneration
      let used = false
      return Object.freeze({
        activate(binding: YidaOwnerRuntimeBinding): Promise<Readonly<{ stop(): Promise<void> }>> {
          try {
            if (terminal || used || generation !== capabilityGeneration || active) fail('INACTIVE')
            used = true
            const closed = record(binding, ['createPrimitives', 'createSendPort'])
            for (const key of ['createPrimitives', 'createSendPort']) {
              if (typeof closed[key] !== 'function' || types.isProxy(closed[key])) fail('INPUT')
            }
            // Registration only captures functions; it does no DB, grant,
            // material, token or network work and is allowed while OFF.
            const state: Registration = { closed: false, runs: new Set(),
              createPrimitives: closed.createPrimitives as YidaOwnerRuntimeBinding['createPrimitives'],
              createSendPort: closed.createSendPort as YidaOwnerRuntimeBinding['createSendPort'] }
            active = state
            return Promise.resolve(Object.freeze({ stop: () => {
              if (active === state && !state.closed) ++capabilityGeneration
              return drain(state)
            } }))
          } catch (error) {
            try { closeError(error) } catch (closed) { return rejected(closed) }
          }
        },
      })
    },
    prepareDraft(context: YidaOwnerActor, supplied: YidaOwnerPrepareDraftInput) {
      return input(() => {
        const parsed = record(supplied, ['config', 'rowsText', 'allocation'], ['config', 'rowsText'])
        if (typeof parsed.rowsText !== 'string' || Buffer.byteLength(parsed.rowsText, 'utf8') > 16 * 1024 * 1024) fail('INPUT')
        return parsed
      }, parsed => execute(context, {}, true, authority => authority.prepareDraft(parsed)))
    },
    preview(context: YidaOwnerActor, supplied: YidaOwnerPreviewInput) {
      return input(() => {
        const parsed = record(supplied, ['operationId', 'rowKey'])
        return { operationId: id(parsed.operationId), rowKey: id(parsed.rowKey) }
      }, parsed => execute(context, {}, true, authority => authority.preview(parsed)))
    },
    approve(context: YidaOwnerActor, supplied: YidaOwnerApproveInput) {
      return input(() => {
        const parsed = record(supplied, ['operationId', 'rowKey', 'confirmationId', 'ttlMs'], ['operationId', 'rowKey', 'confirmationId'])
        return { ...parsed, operationId: id(parsed.operationId), rowKey: id(parsed.rowKey), confirmationId: id(parsed.confirmationId) }
      }, parsed => execute(context, {}, true, authority => authority.approvals.approve(parsed)))
    },
    revoke(context: YidaOwnerActor, supplied: YidaOwnerGrantInput) {
      return input(() => ({ grantId: id(record(supplied, ['grantId']).grantId) }),
        parsed => execute(context, {}, false, authority => authority.approvals.revoke(parsed)))
    },
    observe(context: YidaOwnerActor, supplied: YidaOwnerGrantInput) {
      return input(() => ({ grantId: id(record(supplied, ['grantId']).grantId) }),
        parsed => execute(context, {}, false, authority => authority.observe(parsed)))
    },
    submit(context: YidaOwnerActor, supplied: YidaOwnerSubmitInput, options: { signal?: AbortSignal } = {}) {
      return input(() => {
        const parsed = record(supplied, ['grantId', 'submissionId'])
        return { grantId: id(parsed.grantId), submissionId: id(parsed.submissionId) }
      }, parsed => execute(context, options, true, async (authority, state, fixed, checkpoint, signal, checked) => {
        const boundFetch: typeof fetch = (request, init) => checked(() => fetcher(request, init))
        const port = record(state.createSendPort(Object.freeze({ context: fixed, authority, fetch: boundFetch, readEnablement, timeoutMs })),
          ['submit', 'inspect'], ['submit'])
        if (typeof port.submit !== 'function' || types.isProxy(port.submit)) fail('UNAVAILABLE')
        const submit = port.submit as Send
        checkpoint()
        const response = await submit(parsed, { signal })
        checkpoint()
        return submitView(response, parsed.grantId)
      }))
    },
    deactivate(): Promise<void> {
      ++capabilityGeneration
      return active ? drain(active) : Promise.resolve()
    },
    stop(): Promise<void> {
      if (terminalDrain) return terminalDrain
      terminal = true
      ++capabilityGeneration
      terminalDrain = active ? drain(active) : Promise.resolve()
      return terminalDrain
    },
  })
}
