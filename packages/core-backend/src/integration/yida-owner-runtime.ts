import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  createInternalYidaSendExecutionAuthority,
  yidaSendApprovalErrorCode,
  type YidaSendExecutionPrimitives,
  type YidaSourceBindingReauthorizer,
} from './yida-send-approval-service'
import { yidaIssueConfirmLiveRecheck, type YidaIssueConfirmRecheck } from './yida-issue-confirm-writeback-authority'

// Host private: authentication supplies actor, and the actual core authority
// independently proves live ACL and the permanent target owner in PostgreSQL.
// This runtime is admission/lifetime control, never an authority substitute.
export type YidaOwnerActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
type Authority = ReturnType<typeof createInternalYidaSendExecutionAuthority>
type Send = (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
type IssueConfirmRecheckPort = (input: unknown) => Promise<boolean>
export type YidaOwnerRuntimeBinding = Readonly<{
  createPrimitives(context: YidaOwnerActor): YidaSendExecutionPrimitives
  createSendPort(options: Readonly<{
    context: YidaOwnerActor; authority: Authority; fetch: typeof fetch
    readEnablement: () => unknown; timeoutMs: number
    // Y9: present only when the binding carries the write-back capability (it arms the post-ACK hook).
    issueConfirmRecheck?: IssueConfirmRecheckPort
  }>): { submit: Send; inspect?(input: unknown): Promise<unknown> }
  // YiDa 发料确认日期回写 (design baseline v2.3 §7.3, slice Y9): optional, both or neither.
  createIssueConfirmWriteback?(options: Readonly<{ context: YidaOwnerActor; recheck: IssueConfirmRecheckPort }>): { run(input: unknown): Promise<unknown> }
  issueConfirmWritebackEnabled?(): boolean
}>
export type YidaOwnerRuntimeDependencies = {
  database: { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
  security: { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
  fetch: typeof fetch
  readEnablement?: () => unknown
  timeoutMs?: number
  // Y2: INTEGRATION_YIDA_MULTI_TARGET_ENABLED, read per call (exact 'true'). Absent or anything else =
  // the original single-target authority: no targetRef accepted, slot 1 only. Never send authority.
  readMultiTargetEnablement?: () => unknown
  // D20 (design baseline v2.3 §3.3/§7.2): INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS, an exact comma-separated
  // list of target refs that, like slot 1 (the material TEST copy, R-71 decision 1), may still take unbound
  // rows. Read per call; absent, empty or malformed = no such target. Every other target requires binding.
  readUnboundTestTargetRefs?: () => unknown
  // D21 (design baseline v2.3 §7.2): the host's in-transaction re-authorization of a bound row, run by the core
  // service inside its approval and admission transactions (yida-source-reauthorization-host.ts). Captured once;
  // absent = the service refuses every bound row (fail closed). Never authority for an unbound (pasted) row.
  reauthorizeSourceBinding?: YidaSourceBindingReauthorizer
  // Y9 (design baseline v2.3 §7.3, D13 a): the write-back's live re-check, run on the run-scoped database. Defaults to the
  // real host check (yida-issue-confirm-writeback-authority.ts); a unit suite may substitute it. Never a request input.
  issueConfirmRecheck?: YidaIssueConfirmRecheck
}
export type YidaOwnerIssueConfirmWritebackInput = Readonly<{ ledgerIds?: readonly string[]; limit?: number }>
export type YidaOwnerPrepareDraftInput = Readonly<{ config: unknown; rowsText: string; allocation?: unknown; targetRef?: string; sourceBinding?: unknown }>
export type YidaOwnerProveDraftOwnerInput = Readonly<{ targetRef?: string }>
export type YidaOwnerPreviewInput = Readonly<{ operationId: string; rowKey: string; targetRef?: string }>
export type YidaOwnerApproveInput = YidaOwnerPreviewInput & Readonly<{ confirmationId: string; ttlMs?: number }>
export type YidaOwnerGrantInput = Readonly<{ grantId: string }>
export type YidaOwnerSubmitInput = YidaOwnerGrantInput & Readonly<{ submissionId: string }>
type Code = 'INPUT' | 'DISABLED' | 'INACTIVE' | 'UNAVAILABLE' | 'CANCELLED'
const CODES = new Set<unknown>(['INPUT', 'DISABLED', 'INACTIVE', 'UNAVAILABLE', 'CANCELLED'])
const ownErrors = new WeakMap<object, Code>()
const MAX_RUNS = 32
const TARGET_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const META = ['grantId', 'operationId', 'rowKey', 'targetRef', 'approvedAt', 'expiresAt',
  'maxAttempts', 'remainingAttempts', 'status', 'revoked', 'admissionId', 'ledgerId', 'canSend', 'externalWriteAttempted']
const DELIVERY_STATES = new Set(['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'])
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
type Row = Record<string, unknown>
// A host dependency the run must wait for before it retires, WITHOUT a checkpoint after it settles.
type Tracked = <T>(pending: Promise<T>) => Promise<T>
type Run = { controller: AbortController; pending: Promise<unknown>; dependencies: Set<Promise<unknown>> }
type Registration = {
  closed: boolean; runs: Set<Run>
  createPrimitives: YidaOwnerRuntimeBinding['createPrimitives']
  createSendPort: YidaOwnerRuntimeBinding['createSendPort']
  createIssueConfirmWriteback?: NonNullable<YidaOwnerRuntimeBinding['createIssueConfirmWriteback']>
  issueConfirmWritebackEnabled?: NonNullable<YidaOwnerRuntimeBinding['issueConfirmWritebackEnabled']>
  draining?: Promise<void>
}
type RunDatabase = { transaction<R>(callback: (trx: Queryable) => Promise<R>): Promise<R> }
const WRITEBACK_RESULT_KINDS = new Set(['skip', 'retryable', 'outcome'])
const WRITEBACK_MAX_BATCH = 100
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

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
// Y9: the write-back run's values-free projection — ledger ids, closed kinds, fixed codes / reasons / outcomes, the
// written day and its zone. Anything else (a project number, a key, a message) cannot cross this boundary.
function writebackView(value: unknown): Readonly<Row> {
  const raw = record(value, ['enabled', 'results', 'stopped'], ['enabled', 'results'])
  if (typeof raw.enabled !== 'boolean' || !Array.isArray(raw.results) || raw.results.length > WRITEBACK_MAX_BATCH
    || (raw.enabled === false && raw.results.length !== 0)
    || (Object.hasOwn(raw, 'stopped') && raw.stopped !== 'SWITCH_OFF')) fail('UNAVAILABLE')
  const results = raw.results.map(item => {
    const kind = record(item, ['ledgerId', 'kind', 'reason', 'code', 'outcome', 'recorded', 'date', 'timeZone'], ['ledgerId', 'kind'])
    if (!WRITEBACK_RESULT_KINDS.has(kind.kind as string)) fail('UNAVAILABLE')
    const ledgerId = id(kind.ledgerId)
    if (kind.kind === 'skip') {
      const row = record(item, ['ledgerId', 'kind', 'reason'])
      if (typeof row.reason !== 'string' || !/^[a-z_]{1,64}$/.test(row.reason)) fail('UNAVAILABLE')
      return Object.freeze({ ledgerId, kind: 'skip', reason: row.reason })
    }
    if (kind.kind === 'retryable') {
      const row = record(item, ['ledgerId', 'kind', 'code'])
      if (typeof row.code !== 'string' || !CODE.test(row.code)) fail('UNAVAILABLE')
      return Object.freeze({ ledgerId, kind: 'retryable', code: row.code })
    }
    const dated = Object.hasOwn(item as object, 'date')
    const row = record(item, dated ? ['ledgerId', 'kind', 'outcome', 'recorded', 'date', 'timeZone'] : ['ledgerId', 'kind', 'outcome', 'recorded'])
    if (typeof row.outcome !== 'string' || !/^[a-z_]{1,64}$/.test(row.outcome) || typeof row.recorded !== 'boolean'
      || (dated && (typeof row.date !== 'string' || !DAY.test(row.date) || typeof row.timeZone !== 'string' || !row.timeZone
        || row.timeZone.length > 64))) fail('UNAVAILABLE')
    return Object.freeze({ ledgerId, kind: 'outcome', outcome: row.outcome, recorded: row.recorded,
      ...(dated ? { date: row.date, timeZone: row.timeZone } : {}) })
  })
  return Object.freeze({ enabled: raw.enabled, results: Object.freeze(results),
    ...(Object.hasOwn(raw, 'stopped') ? { stopped: 'SWITCH_OFF' } : {}) })
}
function writebackInput(value: unknown): Readonly<Row> {
  const parsed = record(value, ['ledgerIds', 'limit'], [])
  const result: Row = {}
  if (Object.hasOwn(parsed, 'ledgerIds')) {
    const ids = parsed.ledgerIds
    if (!Array.isArray(ids) || types.isProxy(ids) || ids.length < 1 || ids.length > WRITEBACK_MAX_BATCH) fail('INPUT')
    const seen = new Set<string>()
    for (const value of ids) { const key = id(value); if (seen.has(key)) fail('INPUT'); seen.add(key) }
    result.ledgerIds = Object.freeze([...seen])
  }
  if (Object.hasOwn(parsed, 'limit')) {
    if (!Number.isSafeInteger(parsed.limit) || Number(parsed.limit) < 1 || Number(parsed.limit) > WRITEBACK_MAX_BATCH) fail('INPUT')
    result.limit = parsed.limit
  }
  return Object.freeze(result)
}

export function createYidaOwnerRuntime(dependencies: YidaOwnerRuntimeDependencies) {
  // These are trusted host dependencies, captured once with their native owner.
  const transaction: YidaOwnerRuntimeDependencies['database']['transaction'] = dependencies.database.transaction.bind(dependencies.database)
  const encrypt: YidaOwnerRuntimeDependencies['security']['encrypt'] = dependencies.security.encrypt.bind(dependencies.security)
  const decrypt: YidaOwnerRuntimeDependencies['security']['decrypt'] = dependencies.security.decrypt.bind(dependencies.security)
  const fetcher = dependencies.fetch
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  const readMultiTarget = dependencies.readMultiTargetEnablement ?? (() => 'false')
  const readUnboundTestTargetRefs = dependencies.readUnboundTestTargetRefs ?? (() => undefined)
  const reauthorizeSourceBinding = dependencies.reauthorizeSourceBinding
  const issueConfirmRecheck = dependencies.issueConfirmRecheck ?? yidaIssueConfirmLiveRecheck
  const timeoutMs = dependencies.timeoutMs ?? 10000
  if (typeof fetcher !== 'function' || typeof readEnablement !== 'function' || typeof readMultiTarget !== 'function'
    || typeof readUnboundTestTargetRefs !== 'function' || typeof issueConfirmRecheck !== 'function' || types.isProxy(issueConfirmRecheck)
    || (reauthorizeSourceBinding !== undefined && (typeof reauthorizeSourceBinding !== 'function' || types.isProxy(reauthorizeSourceBinding)))
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('INPUT')
  // Exact literal, never coerced; a throwing or async switch is OFF.
  function multiTargetOn(): boolean {
    let flag: unknown
    try { flag = readMultiTarget() } catch { return false }
    const on = flag === 'true'
    if (!on) consumeRejection(flag)
    return on
  }
  // D20 allowlist, exact list: comma-separated target refs (UUIDs), each byte-exact (no trim, no case folding).
  // Anything else (a throwing or async reader, an empty entry, a non-UUID entry) is the empty list, so a
  // malformed value can only make formal targets stricter, never admit an unbound row.
  function unboundTestTargetRefs(): ReadonlySet<string> {
    let value: unknown
    try { value = readUnboundTestTargetRefs() } catch { return new Set() }
    if (typeof value !== 'string') { consumeRejection(value); return new Set() }
    if (value === '') return new Set()
    const entries = value.split(',')
    if (entries.some(entry => !TARGET_REF.test(entry))) return new Set()
    return new Set(entries)
  }
  let active: Registration | undefined, capabilityGeneration = 0, terminal = false
  let terminalDrain: Promise<void> | undefined

  function enabled() {
    let value: unknown
    try { value = readEnablement() } catch { fail('DISABLED') }
    if (value !== 'true') { consumeRejection(value); fail('DISABLED') }
  }
  function close(state: Registration) {
    state.closed = true
    // The native lifetime signal aborts synchronously, before drain starts. A
    // dependency that ignores cancellation remains pending.
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
    work: (authority: Authority, state: Registration, context: YidaOwnerActor, checkpoint: () => void, signal: AbortSignal, tracked: Tracked,
      database: RunDatabase) => Promise<T>): Promise<T> {
    try {
      const context = actor(inputActor), caller = signalOf(options), state = active
      if (terminal || !state || state.closed) fail('INACTIVE')
      // Gate 1 (R-71 ⑦.1): the caller's signal is read exactly once, here, before anything is
      // admitted. It is NOT subscribed to the run: once admission has committed (one-time grant
      // consumed, business key fenced) a browser timeout, panel unmount or dropped connection must
      // not cancel the attempt. The run controller below is aborted only by the host lifetime.
      if (caller && abortedGetter.call(caller)) fail('CANCELLED')
      if (requiresEnablement) enabled()
      if (state.runs.size >= MAX_RUNS) fail('UNAVAILABLE')
      const controller = new AbortController()
      const checkpoint = () => {
        if (abortedGetter.call(controller.signal)) fail('CANCELLED')
        if (terminal || state.closed || state !== active) fail('INACTIVE')
        if (requiresEnablement) enabled()
      }
      const tracked: Tracked = async pending => {
        run.dependencies.add(pending)
        try { return await pending } finally { run.dependencies.delete(pending) }
      }
      async function checked<R>(operation: () => Promise<R>): Promise<R> {
        checkpoint()
        const result = await tracked(operation())
        checkpoint()
        return result
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
          // Captured once per run: a switch flip mid-run cannot widen this authority.
          const authority = createInternalYidaSendExecutionAuthority({ database, security, context, primitives,
            ...(multiTargetOn() ? { multiTarget: true } : {}), unboundTestTargetRefs: unboundTestTargetRefs(),
            ...(reauthorizeSourceBinding ? { reauthorizeSourceBinding } : {}) })
          checkpoint()
          return await checked(() => work(authority, state, context, checkpoint, controller.signal, tracked, database))
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
          while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])
          state.runs.delete(run)
          if (terminal || state.closed || state !== active) fail('CANCELLED')
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
            const closed = record(binding, ['createPrimitives', 'createSendPort', 'createIssueConfirmWriteback', 'issueConfirmWritebackEnabled'],
              ['createPrimitives', 'createSendPort'])
            // Y9: the write-back members come together or not at all.
            const writeback = Object.hasOwn(closed, 'createIssueConfirmWriteback')
            if (writeback !== Object.hasOwn(closed, 'issueConfirmWritebackEnabled')) fail('INPUT')
            for (const key of ['createPrimitives', 'createSendPort', ...(writeback ? ['createIssueConfirmWriteback', 'issueConfirmWritebackEnabled'] : [])]) {
              if (typeof closed[key] !== 'function' || types.isProxy(closed[key])) fail('INPUT')
            }
            // Registration only captures functions; it does no DB, grant,
            // material, token or network work and is allowed while OFF.
            const state: Registration = { closed: false, runs: new Set(),
              createPrimitives: closed.createPrimitives as YidaOwnerRuntimeBinding['createPrimitives'],
              createSendPort: closed.createSendPort as YidaOwnerRuntimeBinding['createSendPort'],
              ...(writeback ? {
                createIssueConfirmWriteback: closed.createIssueConfirmWriteback as NonNullable<YidaOwnerRuntimeBinding['createIssueConfirmWriteback']>,
                issueConfirmWritebackEnabled: closed.issueConfirmWritebackEnabled as NonNullable<YidaOwnerRuntimeBinding['issueConfirmWritebackEnabled']>,
              } : {}) }
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
        const parsed = record(supplied, ['config', 'rowsText', 'allocation', 'targetRef', 'sourceBinding'], ['config', 'rowsText'])
        if (typeof parsed.rowsText !== 'string' || Buffer.byteLength(parsed.rowsText, 'utf8') > 16 * 1024 * 1024) fail('INPUT')
        if (Object.hasOwn(parsed, 'targetRef')) { if (!multiTargetOn()) fail('INPUT'); id(parsed.targetRef) }
        // A source binding exists only on the multi-target sheet-source path (D17 a); the route produces it, a
        // request body cannot. The plugin compiler owns its closed shape.
        if (Object.hasOwn(parsed, 'sourceBinding') && !multiTargetOn()) fail('INPUT')
        return parsed
      }, parsed => execute(context, {}, true, authority => authority.prepareDraft(parsed)))
    },
    // Y2 sheet source: prove the live owner (and the named target) with prepareDraft's own refusals before
    // the route reads any sheet row. Switch ON only; no data out, nothing written.
    proveDraftOwner(context: YidaOwnerActor, supplied: YidaOwnerProveDraftOwnerInput) {
      return input(() => {
        if (!multiTargetOn()) fail('INPUT')
        const parsed = record(supplied, ['targetRef'], [])
        return Object.hasOwn(parsed, 'targetRef') ? { targetRef: id(parsed.targetRef) } : {}
      }, parsed => execute(context, {}, true, authority => authority.proveDraftTarget(parsed)))
    },
    preview(context: YidaOwnerActor, supplied: YidaOwnerPreviewInput) {
      return input(() => {
        const parsed = record(supplied, ['operationId', 'rowKey', 'targetRef'], ['operationId', 'rowKey'])
        if (Object.hasOwn(parsed, 'targetRef') && !multiTargetOn()) fail('INPUT')
        return { operationId: id(parsed.operationId), rowKey: id(parsed.rowKey),
          ...(Object.hasOwn(parsed, 'targetRef') ? { targetRef: id(parsed.targetRef) } : {}) }
      }, parsed => execute(context, {}, true, authority => authority.preview(parsed)))
    },
    approve(context: YidaOwnerActor, supplied: YidaOwnerApproveInput) {
      return input(() => {
        const parsed = record(supplied, ['operationId', 'rowKey', 'confirmationId', 'ttlMs', 'targetRef'], ['operationId', 'rowKey', 'confirmationId'])
        if (Object.hasOwn(parsed, 'targetRef') && !multiTargetOn()) fail('INPUT')
        return { ...parsed, operationId: id(parsed.operationId), rowKey: id(parsed.rowKey), confirmationId: id(parsed.confirmationId),
          ...(Object.hasOwn(parsed, 'targetRef') ? { targetRef: id(parsed.targetRef) } : {}) }
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
      }, parsed => execute(context, options, true, async (authority, state, fixed, checkpoint, signal, tracked, database) => {
        // Gate 6 (R-71 ⑦.1, c4): checkpoint BEFORE the request only. A Response that has already
        // been received is a fact about the remote system; re-checking after it resolved would turn
        // a received 2xx into outcome_unknown when the switch flipped or the host closed mid-flight.
        // The dependency is still tracked so drain waits for it, and the pre-output checkpoint
        // below still refuses to expose the result while OFF/closed (the ledger is the record).
        const boundFetch: typeof fetch = async (request, init) => { checkpoint(); return tracked(fetcher(request, init)) }
        // Y9: a binding with the write-back capability also gets the live re-check (on THIS run's database, so drain
        // waits for it), which arms its best-effort post-ACK hook. Never offered to a binding without the capability.
        const recheck = state.createIssueConfirmWriteback
          ? { issueConfirmRecheck: (request: unknown) => issueConfirmRecheck(database, fixed, request) } : {}
        const port = record(state.createSendPort(Object.freeze({ context: fixed, authority, fetch: boundFetch, readEnablement, timeoutMs,
          ...recheck })),
          ['submit', 'inspect'], ['submit'])
        if (typeof port.submit !== 'function' || types.isProxy(port.submit)) fail('UNAVAILABLE')
        const submit = port.submit as Send
        checkpoint()
        const response = await submit(parsed, { signal })
        checkpoint()
        return submitView(response, parsed.grantId)
      }))
    },
    // Values-free display bit for a response the caller already authorized
    // (owner + live admin). Same exact-literal source as enabled(); never
    // throws and is never authority: every send action rechecks enabled().
    sendEnabled(): boolean {
      let value: unknown
      try { value = readEnablement() } catch { return false }
      if (value === 'true') return true
      consumeRejection(value)
      return false
    },
    // Y2 display/shape bit for the owner route (target picker, sheet source). Never authority:
    // the run's authority re-reads the same exact literal and refuses a targetRef while OFF.
    multiTargetEnabled(): boolean { return multiTargetOn() },
    // YiDa 发料确认日期回写 (design baseline v2.3 §7.3, slice Y9): the route's 404-while-OFF bit. It is the plugin core's
    // own exact-literal predicate of INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED (no second reader of the
    // variable in the host); false without an active binding that carries the capability. Never authority: every run
    // reads the switch again before any dependency is touched.
    issueConfirmWritebackEnabled(): boolean {
      const state = active
      if (terminal || !state || state.closed || !state.issueConfirmWritebackEnabled) return false
      try { return state.issueConfirmWritebackEnabled() === true } catch { return false }
    },
    // The owner recovery entry (D5 b / D9): one bounded, idempotent write-back run for THIS owner's acknowledged
    // issue-confirm CREATEs — named ledger rows or the next untraced batch. It never needs the send switch, never
    // builds a send port, a runner, a transport or a token client, and writes no ledger, audit, grant or admission:
    // the only rows it can add are trace rows, the only cell it can change is issueConfirmDate.
    issueConfirmWriteback(context: YidaOwnerActor, supplied: YidaOwnerIssueConfirmWritebackInput) {
      return input(() => writebackInput(supplied),
        parsed => execute(context, {}, false, async (authority, state, fixed, _checkpoint, _signal, _tracked, database) => {
          if (!state.createIssueConfirmWriteback || !state.issueConfirmWritebackEnabled) fail('UNAVAILABLE')
          // Switch OFF (a flip after the route's 404 check): refused before any proof, read or write.
          let on = false
          try { on = state.issueConfirmWritebackEnabled() === true } catch { on = false }
          if (!on) fail('DISABLED')
          // The owner routes' own live proof first (live integration admin + the permanent slot-1 owner, i.e. the anchor
          // owner of every target), so a refused caller learns nothing and nothing is read; the per-row re-check under
          // the sheet lease follows inside the run.
          await authority.proveDraftTarget({})
          const writeback = record(state.createIssueConfirmWriteback(Object.freeze({ context: fixed,
            recheck: (request: unknown) => issueConfirmRecheck(database, fixed, request) })), ['run'])
          if (typeof writeback.run !== 'function' || types.isProxy(writeback.run)) fail('UNAVAILABLE')
          return writebackView(await (writeback.run as (input: unknown) => Promise<unknown>)(parsed))
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
