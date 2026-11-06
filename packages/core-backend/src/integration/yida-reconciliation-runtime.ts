import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertAutomationIntegrationActor, AutomationActorAuthorityError } from './automation-live-authority'
import type { YidaInitializationDatabase } from './yida-initialization-bootstrap'

// R-71 ⑦.5 cut-over reconciliation (design baseline v2.3 §8): the FOURTH host-private YiDa runtime, beside the
// owner, initialization and connection-test runtimes, which stay untouched. Its own default-OFF switch
// INTEGRATION_YIDA_RECONCILE_READ_ENABLED (exact literal 'true'); it never reads the send switch, so a
// reconciliation can run while sending stays off. Each call re-proves live integration admin + the anchor
// owner/tenant (slot 1) in its own short transaction, commits it, and only then lets the plugin port read.
// The plugin port reads YiDa page by page (fixed token + search endpoints only) and inserts local evidence;
// it has no form-transport path. This runtime receives a closed, values-free view only.
export type YidaReconciliationActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
export type YidaReconciliationInput = Readonly<{
  commandId: string; mode: 'count' | 'register'; projectNo: string; projectKeyTarget: string
  expectedKeyTargets: readonly string[]; targetRef?: string; pageSize?: number; pagesPerStep?: number
}>
export type YidaReconciliationCounts = Readonly<Record<typeof COUNT_KEYS[number], number>>
export type YidaReconciliationView = Readonly<{
  runId: string; commandId: string; targetRef: string; mode: 'count' | 'register'
  status: 'running' | 'completed' | 'failed'; nextPageNumber: number; pagesDone: number
  totalCountFirst: number | null; totalCountLast: number | null; counts: YidaReconciliationCounts
  lastErrorCode: string | null; tokenIssued: boolean; canSend: false; externalWriteAttempted: false
  businessVerified: false; historyVerified: false; formOwnershipVerified: false
}>
type Port = Readonly<{
  step(input: unknown, options: { signal: AbortSignal }): Promise<unknown>
  inspect(input: unknown): Promise<unknown>
}>
export type YidaReconciliationRuntimeBinding = Readonly<{
  createReconciliationPort(options: Readonly<{
    context: YidaReconciliationActor; fetch: typeof fetch; readEnablement: () => unknown; timeoutMs: number
  }>): Port
}>
export type YidaReconciliationRuntimeDependencies = {
  database: YidaInitializationDatabase
  fetch: typeof fetch
  readEnablement?: () => unknown
  readMultiTargetEnablement?: () => unknown
  timeoutMs?: number
}
type Code = 'INPUT' | 'DISABLED' | 'DENIED' | 'CONFLICT' | 'NOT_FOUND' | 'CANCELLED' | 'INACTIVE' | 'UNAVAILABLE'
const CODES = new Set<unknown>(['INPUT', 'DISABLED', 'DENIED', 'CONFLICT', 'NOT_FOUND', 'CANCELLED', 'INACTIVE', 'UNAVAILABLE'])
// Plugin port codes that pass through unchanged; anything else is UNAVAILABLE.
const PORT_CODES = new Set<unknown>(['INPUT', 'DISABLED', 'CONFLICT', 'NOT_FOUND', 'CANCELLED', 'UNAVAILABLE'])
const ownErrors = new WeakMap<object, Code>()
export class YidaReconciliationError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (CODES.has(code) ? code : 'UNAVAILABLE') as Code
    super(`YIDA_RECONCILE_${fixed}`)
    this.name = 'YidaReconciliationError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
/** The decoder consults its own WeakMap only; a foreign rejection is never read. */
export function yidaReconciliationErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_RECONCILE_${code}`
}
export const YIDA_RECONCILIATION_MAX_RUNS = 32
const COUNT_KEYS = ['scanned', 'registered', 'would_register', 'already_reconciled', 'duplicate_remote', 'own_acknowledged',
  'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch', 'key_unmatchable'] as const
const VIEW_KEYS = ['runId', 'commandId', 'targetRef', 'mode', 'status', 'nextPageNumber', 'pagesDone', 'totalCountFirst',
  'totalCountLast', 'counts', 'lastErrorCode', 'tokenIssued', 'canSend', 'externalWriteAttempted', 'businessVerified',
  'historyVerified', 'formOwnershipVerified'] as const
const ERROR_CODES = new Set<unknown>([null, 'RETRY', 'THROTTLED', 'RESPONSE', 'TOO_LARGE', 'UNAVAILABLE', 'ABORTED', 'BUDGET', 'TOTAL_CHANGED'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
type Row = Record<string, unknown>
function fail(code: Code): never { throw new YidaReconciliationError(code) }
function closeError(error: unknown): never {
  const own = ownErrors.get(error as object)
  if (own) fail(own)
  // A plugin port error is read through its own data property only (never a getter or a prototype).
  if (error && typeof error === 'object' && !types.isProxy(error)) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code === 'string' && code.startsWith('YIDA_RECONCILE_')) {
      const suffix = code.slice('YIDA_RECONCILE_'.length)
      if (PORT_CODES.has(suffix)) fail(suffix as Code)
    }
  }
  fail('UNAVAILABLE')
}
function record(value: unknown, keys: readonly string[], required = keys): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INPUT')
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(properties, key))) fail('INPUT')
  const result: Row = Object.create(null)
  for (const key of Object.keys(properties)) {
    const property = properties[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    result[key] = property.value
  }
  return result
}
function id(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function int(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail('INPUT')
  return value as number
}
function captureActor(value: unknown): YidaReconciliationActor {
  const row = record(value, ['actorId', 'tenantId', 'workspaceId'])
  if (row.workspaceId !== null) fail('INPUT')
  return Object.freeze({ actorId: id(row.actorId), tenantId: id(row.tenantId), workspaceId: null })
}
function captureInput(value: unknown, multiTarget: boolean): YidaReconciliationInput {
  const optional = multiTarget ? ['targetRef', 'pageSize', 'pagesPerStep'] : ['pageSize', 'pagesPerStep']
  const keys = ['commandId', 'mode', 'projectNo', 'projectKeyTarget', 'expectedKeyTargets']
  const row = record(value, [...keys, ...optional], keys)
  if (typeof row.commandId !== 'string' || !UUID.test(row.commandId)) fail('INPUT')
  if (row.mode !== 'count' && row.mode !== 'register') fail('INPUT')
  const targets = row.expectedKeyTargets
  if (!Array.isArray(targets) || types.isProxy(targets) || Object.getPrototypeOf(targets) !== Array.prototype
    || targets.length < 1 || targets.length > 32) fail('INPUT')
  const expectedKeyTargets = Object.freeze(Array.from({ length: targets.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(targets, String(index))
    if (!property || !Object.hasOwn(property, 'value')) fail('INPUT')
    return id(property.value)
  }))
  return Object.freeze({ commandId: row.commandId, mode: row.mode, projectNo: id(row.projectNo, 64),
    projectKeyTarget: id(row.projectKeyTarget), expectedKeyTargets,
    ...(Object.hasOwn(row, 'targetRef') ? { targetRef: id(row.targetRef) } : {}),
    ...(Object.hasOwn(row, 'pageSize') ? { pageSize: int(row.pageSize, 1, 100) } : {}),
    ...(Object.hasOwn(row, 'pagesPerStep') ? { pagesPerStep: int(row.pagesPerStep, 1, 10) } : {}) })
}
function signal(value: unknown): AbortSignal | undefined {
  const parsed = record(value, ['signal'], [])
  if (parsed.signal === undefined) return undefined
  if (!parsed.signal || typeof parsed.signal !== 'object' || types.isProxy(parsed.signal)
    || Object.getPrototypeOf(parsed.signal) !== AbortSignal.prototype) fail('INPUT')
  try { abortGetter.call(parsed.signal) } catch { fail('INPUT') }
  return parsed.signal as AbortSignal
}
function consumeRejection(value: unknown): void {
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* No inspection of foreign asynchronous control. */ }
}
function nullableCount(value: unknown): number | null {
  if (value === null) return null
  return int(value, 0, 60000)
}
/** Closed view check: any extra/missing key, a non-false safety bit or an unknown code is UNAVAILABLE. */
function viewOf(value: unknown, expectedRunId?: string): YidaReconciliationView {
  try {
    if (!Object.isFrozen(value)) fail('UNAVAILABLE')
    const row = record(value, VIEW_KEYS)
    const counts = record(row.counts, COUNT_KEYS)
    for (const key of ['canSend', 'externalWriteAttempted', 'businessVerified', 'historyVerified', 'formOwnershipVerified']) {
      if (row[key] !== false) fail('UNAVAILABLE')
    }
    if (typeof row.runId !== 'string' || !UUID.test(row.runId) || (expectedRunId !== undefined && row.runId !== expectedRunId)
      || typeof row.commandId !== 'string' || !UUID.test(row.commandId) || (row.mode !== 'count' && row.mode !== 'register')
      || !['running', 'completed', 'failed'].includes(row.status as string) || typeof row.tokenIssued !== 'boolean'
      || !ERROR_CODES.has(row.lastErrorCode)) fail('UNAVAILABLE')
    return Object.freeze({ runId: row.runId, commandId: row.commandId, targetRef: id(row.targetRef), mode: row.mode,
      status: row.status as YidaReconciliationView['status'], nextPageNumber: int(row.nextPageNumber, 1, 601),
      pagesDone: int(row.pagesDone, 0, 600), totalCountFirst: nullableCount(row.totalCountFirst),
      totalCountLast: nullableCount(row.totalCountLast),
      counts: Object.freeze(Object.fromEntries(COUNT_KEYS.map(key => [key, int(counts[key], 0, 60000)]))) as YidaReconciliationCounts,
      lastErrorCode: row.lastErrorCode as string | null, tokenIssued: row.tokenIssued, canSend: false,
      externalWriteAttempted: false, businessVerified: false, historyVerified: false, formOwnershipVerified: false })
  } catch { fail('UNAVAILABLE') }
}
type Run = { controller: AbortController; pending: Promise<unknown> }
type Registration = { closed: boolean; createPort: YidaReconciliationRuntimeBinding['createReconciliationPort']; runs: Set<Run>; draining?: Promise<void> }

/** Order per call: capture -> enabled() -> one authorization transaction (live ACL, anchor owner/tenant)
 * -> COMMIT -> enabled() again -> plugin port (which commits its own target transaction before any read). */
export function createYidaReconciliationRuntime(dependencies: YidaReconciliationRuntimeDependencies) {
  if (!dependencies?.database || typeof dependencies.database.transaction !== 'function'
    || typeof dependencies.fetch !== 'function') fail('UNAVAILABLE')
  const transaction = dependencies.database.transaction.bind(dependencies.database) as YidaInitializationDatabase['transaction']
  const fetcher = dependencies.fetch
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  const readMultiTarget = dependencies.readMultiTargetEnablement ?? (() => 'false')
  const timeoutMs = dependencies.timeoutMs ?? 5000
  if (typeof readEnablement !== 'function' || typeof readMultiTarget !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('UNAVAILABLE')
  let active: Registration | undefined, generation = 0, terminal = false, terminalDrain: Promise<void> | undefined
  function literal(read: () => unknown): boolean {
    let value: unknown
    try { value = read() } catch { return false }
    if (value === 'true') return true
    consumeRejection(value)
    return false
  }
  function enabled() { if (!literal(readEnablement)) fail('DISABLED') }
  function drain(state: Registration): Promise<void> {
    state.closed = true
    for (const run of state.runs) run.controller.abort()
    return state.draining ??= Promise.allSettled([...state.runs].map(run => run.pending)).then(() => { if (active === state) active = undefined })
  }
  function execute<T>(actorInput: unknown, options: unknown, capture: () => T,
    work: (port: Port, captured: T, lifetime: AbortSignal) => Promise<unknown>, expectedRunId?: (captured: T) => string | undefined): Promise<YidaReconciliationView> {
    try {
      const actor = captureActor(actorInput), captured = capture(), caller = signal(options), state = active
      if (terminal || !state || state.closed) fail('INACTIVE')
      // Gate-1 rule: the caller's signal is read once, at entry. After that only the host lifetime (deactivate
      // / stop) aborts an in-flight read; a committed page is never rolled back because a browser went away.
      if (caller && abortGetter.call(caller)) fail('CANCELLED')
      enabled()
      if (state.runs.size >= YIDA_RECONCILIATION_MAX_RUNS) fail('UNAVAILABLE')
      const controller = new AbortController()
      const checkpoint = () => {
        if (abortGetter.call(controller.signal)) fail('CANCELLED')
        if (terminal || state.closed || active !== state) fail('INACTIVE')
      }
      const run: Run = { controller, pending: undefined! }
      state.runs.add(run)
      run.pending = Promise.resolve().then(async () => {
        try {
          checkpoint()
          await transaction(async raw => {
            const trx: Queryable = Object.freeze({ query: (sql: string, params?: unknown[]) => { checkpoint(); return raw.query(sql, params) } })
            try { await assertAutomationIntegrationActor(trx, actor) }
            catch (error) {
              checkpoint()
              if (error && typeof error === 'object' && !types.isProxy(error)
                && Object.getPrototypeOf(error) === AutomationActorAuthorityError.prototype
                && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') fail('DENIED')
              fail('UNAVAILABLE')
            }
            const anchors = await trx.query('SELECT slot,owner_id,tenant_id,workspace_id FROM integration_yida_initialization_anchor WHERE slot=1')
            const anchor = anchors.rows[0]
            if (anchors.rows.length !== 1 || anchor.slot !== 1 || anchor.workspace_id !== null) fail('DENIED')
            if (anchor.owner_id !== actor.actorId || anchor.tenant_id !== actor.tenantId) fail('DENIED')
            checkpoint()
          })
          // COMMITTED. No network happened above.
          checkpoint(); enabled()
          const port = record(state.createPort(Object.freeze({ context: actor,
            // Charged to this run and aborted with it (host deactivate / stop).
            fetch: ((request, init) => { checkpoint(); return fetcher(request, init) }) as typeof fetch,
            readEnablement, timeoutMs })), ['step', 'inspect'])
          if (typeof port.step !== 'function' || typeof port.inspect !== 'function' || types.isProxy(port.step)
            || types.isProxy(port.inspect)) fail('UNAVAILABLE')
          const value = await work(port as unknown as Port, captured, controller.signal)
          // A host stopped meanwhile answers CANCELLED; committed pages stay committed and the same
          // commandId reports (or resumes) the run as it stands.
          checkpoint()
          return viewOf(value, expectedRunId?.(captured))
        } catch (error) {
          try { checkpoint() } catch (control) { closeError(control) }
          closeError(error)
        } finally {
          controller.abort()
          state.runs.delete(run)
        }
      })
      void run.pending.catch(() => {})
      return run.pending as Promise<YidaReconciliationView>
    } catch (error) {
      try { closeError(error) } catch (closed) {
        const pending = Promise.reject<YidaReconciliationView>(closed); void pending.catch(() => {}); return pending
      }
    }
  }
  return Object.freeze({
    createPluginCapability() {
      if (terminal) fail('INACTIVE')
      const capturedGeneration = ++generation; let used = false
      return Object.freeze({ activate(binding: YidaReconciliationRuntimeBinding): Promise<Readonly<{ stop(): Promise<void> }>> {
        try {
          if (terminal || used || generation !== capturedGeneration || active) fail('INACTIVE')
          used = true
          const parsed = record(binding, ['createReconciliationPort'])
          if (typeof parsed.createReconciliationPort !== 'function' || types.isProxy(parsed.createReconciliationPort)) fail('INPUT')
          // Registration captures one function only; no DB, token or network work, allowed while OFF.
          const state: Registration = { closed: false, createPort: parsed.createReconciliationPort as Registration['createPort'], runs: new Set() }
          active = state
          return Promise.resolve(Object.freeze({ stop() { if (active === state && !state.closed) ++generation; return drain(state) } }))
        } catch (error) { try { closeError(error) } catch (closed) { const pending = Promise.reject<Readonly<{ stop(): Promise<void> }>>(closed); void pending.catch(() => {}); return pending } }
      } })
    },
    step(actor: YidaReconciliationActor, input: YidaReconciliationInput, options: { signal?: AbortSignal } = {}) {
      return execute(actor, options, () => captureInput(input, literal(readMultiTarget)),
        (port, captured, lifetime) => port.step({ ...captured, expectedKeyTargets: [...captured.expectedKeyTargets] }, { signal: lifetime }))
    },
    inspect(actor: YidaReconciliationActor, input: { runId: string }, options: { signal?: AbortSignal } = {}) {
      return execute(actor, options, () => {
        const runId = record(input, ['runId']).runId
        if (typeof runId !== 'string' || !UUID.test(runId)) fail('INPUT')
        return runId
      }, (port, runId) => port.inspect({ runId }), runId => runId)
    },
    // Values-free display bit for a reply the caller already authorized. Never authority: every call
    // rechecks enabled() twice.
    reconcileEnabled(): boolean { return literal(readEnablement) },
    deactivate() { ++generation; return active ? drain(active) : Promise.resolve() },
    stop() { if (terminalDrain) return terminalDrain; terminal = true; ++generation; return terminalDrain = active ? drain(active) : Promise.resolve() },
  })
}
