import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertAutomationIntegrationActor, AutomationActorAuthorityError } from './automation-live-authority'
import { lockYidaInitializationSlot, type YidaInitializationDatabase } from './yida-initialization-bootstrap'

// Owner-run YiDa 测试连接 (ADR docs/development/takeover-beiliao-20260821/adr-yida-connection-test-20261028.md).
// A third host-private runtime beside the owner and initialization runtimes, which stay untouched.
// It authorizes one owner click, then lets the plugin probe exchange exactly one DingTalk token with
// the pasted appKey/appSecret BEFORE local initialization (candidate mode). The token is discarded
// inside the plugin; this runtime receives a closed { outcome } only. It persists nothing, writes no
// form, never reads INTEGRATION_YIDA_OWNER_SEND_ENABLED and never builds send authority.
export type YidaConnectionTestActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
/** ADR addendum 2026-11-23: the form whose component definitions are read once with the same token.
 * Accepted only while INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED reads exact 'true'. */
export type YidaConnectionTestForm = Readonly<{ appType: string; formUuid: string; systemToken: string; userId: string }>
export type YidaConnectionTestInput = Readonly<{
  commandId: string; mode: 'candidate'; material: Readonly<{ appKey: string; appSecret: string }>
  form?: YidaConnectionTestForm
}>
export type YidaConnectionTestOutcome = 'ok' | 'upstream_rejected' | 'unreachable' | 'timeout'
export type YidaFormReadOutcome = 'ok' | 'upstream_rejected' | 'unreachable' | 'timeout' | 'not_attempted'
export type YidaFormFieldDefinition = Readonly<{ fieldId: string; label: string; componentName: string; parentId: string | null }>
export type YidaFormReadView = Readonly<{ outcome: YidaFormReadOutcome; fields: readonly YidaFormFieldDefinition[] }>
export type YidaConnectionTestView = Readonly<{
  commandId: string; mode: 'candidate'; outcome: YidaConnectionTestOutcome; tokenIssued: boolean
  tokenRetained: false; externalWriteAttempted: false; canSend: false
  /** Present exactly when the request named a form. */
  formRead?: YidaFormReadView
}>
export type YidaConnectionProbe = Readonly<{
  probe(credentials: { appKey: string; appSecret: string }, options: { signal: AbortSignal }): Promise<unknown>
  probeForm?(credentials: { appKey: string; appSecret: string }, form: YidaConnectionTestForm, options: { signal: AbortSignal }): Promise<unknown>
}>
export type YidaConnectionTestRuntimeBinding = Readonly<{
  createConnectionProbe(options: Readonly<{ fetch: typeof fetch }>): YidaConnectionProbe
}>
export type YidaConnectionTestRuntimeDependencies = {
  database: YidaInitializationDatabase
  fetch: typeof fetch
  readEnablement?: () => unknown
  // ADR addendum 2026-11-23: INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED (exact 'true'); absent = OFF. Gates
  // only the optional form-definition read; the test itself still needs readEnablement.
  readFormFieldsEnablement?: () => unknown
}
type Code = 'INPUT' | 'DISABLED' | 'DENIED' | 'CONFLICT' | 'THROTTLED' | 'CANCELLED' | 'INACTIVE' | 'UNAVAILABLE'
const CODES = new Set<unknown>(['INPUT', 'DISABLED', 'DENIED', 'CONFLICT', 'THROTTLED', 'CANCELLED', 'INACTIVE', 'UNAVAILABLE'])
const ownErrors = new WeakMap<object, Code>()
export class YidaConnectionTestError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (CODES.has(code) ? code : 'UNAVAILABLE') as Code
    super(`YIDA_CONNECTION_TEST_${fixed}`)
    this.name = 'YidaConnectionTestError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
// The decoder consults its own WeakMap only; a foreign rejection is never read.
export function yidaConnectionTestErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_CONNECTION_TEST_${code}`
}
/** Whole-probe budget: under the web client's 15 s guard, above undici's 10 s connect timeout, so a
 * dropped connect classifies as 'unreachable' and only a silent answer becomes 'timeout'. */
export const YIDA_CONNECTION_TEST_BUDGET_MS = 12000
/** Longest time from test() entry to the moment the exchange would start (the RC authorization
 * transaction sits in between). Past it the run is UNAVAILABLE with zero fetch and no cooldown stamp,
 * so the server's worst case (about this window + the 12 s budget) stays under the web client's 15 s
 * abort. The client timer starts before the request reaches test(), so the browser shows CANCELLED while
 * the server still exchanges only if middleware and network take over about 1 s; the CANCELLED hint then
 * says the outcome is unknown. */
export const YIDA_CONNECTION_TEST_START_WINDOW_MS = 2000
/** Per-process cooldown between two started exchanges, counted for authorized callers only. */
export const YIDA_CONNECTION_TEST_COOLDOWN_MS = 5000
// Both the start window and the cooldown read the wall clock (Date.now), which the tests drive with
// a fake Date. A backward wall-clock step gives a negative elapsed time, which counts as "not
// throttled" and "inside the window", so it never locks the limiter; at most it can cost one extra
// cooldown later, once the wall clock passes the old stamp again. A forward step either refuses one
// run at the window check (UNAVAILABLE before the exchange, nothing stamped, retry at once) or, landing
// after a started exchange, ends that cooldown early; each click is still at most one exchange.
function elapsedSince(start: number): number { return Date.now() - start }
const MAX_RUNS = 32
const RECEIPT_OUTCOMES = new Set<unknown>(['ok', 'upstream_rejected', 'unreachable'])
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
type Row = Record<string, unknown>
function fail(code: Code): never { throw new YidaConnectionTestError(code) }
function closeError(error: unknown): never { fail(ownErrors.get(error as object) ?? 'UNAVAILABLE') }
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
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function command(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail('INPUT'); return value }
function captureActor(value: unknown): YidaConnectionTestActor {
  const row = record(value, ['actorId', 'tenantId', 'workspaceId'])
  if (row.workspaceId !== null) fail('INPUT')
  return Object.freeze({ actorId: id(row.actorId), tenantId: id(row.tenantId), workspaceId: null })
}
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/u
const FIELD_ID = /^[A-Za-z0-9_-]{1,128}$/u
const COMPONENT = /^[A-Za-z][A-Za-z0-9]{0,63}$/u
const FORM_OUTCOMES = new Set<unknown>(['ok', 'upstream_rejected', 'unreachable', 'timeout', 'not_attempted'])
const MAX_FORM_FIELDS = 256
function captureForm(value: unknown): YidaConnectionTestForm {
  const form = record(value, ['appType', 'formUuid', 'systemToken', 'userId'])
  // appType/formUuid become URL path segments: a closed identifier shape, nothing else.
  for (const key of ['appType', 'formUuid']) if (typeof form[key] !== 'string' || !PATH_ID.test(form[key] as string)) fail('INPUT')
  // systemToken: the initialization material rule (never trimmed). userId: the executionIdentity rule.
  const systemToken = form.systemToken
  if (typeof systemToken !== 'string' || !systemToken || systemToken.length > 4096 || systemToken.trim() !== systemToken
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(systemToken)) fail('INPUT')
  const userId = id(form.userId)
  if (/[\p{Cf}\p{Cs}]/u.test(userId)) fail('INPUT')
  return Object.freeze({ appType: form.appType as string, formUuid: form.formUuid as string, systemToken, userId })
}
function captureInput(value: unknown): YidaConnectionTestInput {
  const row = record(value, ['commandId', 'mode', 'material', 'form'], ['commandId', 'mode', 'material'])
  if (row.mode !== 'candidate') fail('INPUT')
  const material = record(row.material, ['appKey', 'appSecret'])
  // Never trimmed, and refused (INPUT) with surrounding whitespace or a control (Cc), invisible format (Cf)
  // or lone surrogate (Cs) character anywhere: the same rule as the initialization material, so a tested
  // pair can only be one that L4 would seal unchanged.
  for (const key of ['appKey', 'appSecret']) {
    const field = material[key]
    if (typeof field !== 'string' || !field || field.length > 4096 || field.trim() !== field
      || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(field)) fail('INPUT')
  }
  const appKey = material.appKey as string, appSecret = material.appSecret as string
  if (Buffer.byteLength(JSON.stringify({ appKey, appSecret }), 'utf8') > 16 * 1024) fail('INPUT')
  const form = Object.hasOwn(row, 'form') ? captureForm(row.form) : undefined
  return Object.freeze({ commandId: command(row.commandId), mode: 'candidate', material: Object.freeze({ appKey, appSecret }),
    ...(form === undefined ? {} : { form }) })
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
  // A rejected native promise is not enablement and must not become an unhandled rejection.
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* No inspection of foreign asynchronous control. */ }
}
function receipt(value: unknown): 'ok' | 'upstream_rejected' | 'unreachable' {
  // Closed, frozen { outcome } from the plugin probe; anything else (an extra token field, a Proxy,
  // an unfrozen or unknown value) is UNAVAILABLE and nothing of it reaches the view.
  try {
    if (!Object.isFrozen(value)) fail('UNAVAILABLE')
    const row = record(value, ['outcome'])
    if (!RECEIPT_OUTCOMES.has(row.outcome)) fail('UNAVAILABLE')
    return row.outcome as 'ok' | 'upstream_rejected' | 'unreachable'
  } catch { fail('UNAVAILABLE') }
}
// probeForm receipt: closed, frozen { outcome, form }; form is { outcome } or (ok only) { outcome, fields }.
// Each field is re-checked and copied here, so nothing but the four closed keys reaches the view.
function formReceipt(value: unknown): { outcome: 'ok' | 'upstream_rejected' | 'unreachable'; form: YidaFormReadView } {
  try {
    if (!Object.isFrozen(value)) fail('UNAVAILABLE')
    const row = record(value, ['outcome', 'form'])
    if (!RECEIPT_OUTCOMES.has(row.outcome) || !Object.isFrozen(row.form)) fail('UNAVAILABLE')
    const form = record(row.form, ['outcome', 'fields'], ['outcome'])
    if (!FORM_OUTCOMES.has(form.outcome)) fail('UNAVAILABLE')
    // A failed exchange never reads the form; an ok form answer always carries its fields, nothing else does.
    if ((row.outcome !== 'ok') !== (form.outcome === 'not_attempted') || (form.outcome === 'ok') !== Object.hasOwn(form, 'fields')) fail('UNAVAILABLE')
    let fields: YidaFormFieldDefinition[] = []
    if (form.outcome === 'ok') {
      const list = form.fields
      if (!Array.isArray(list) || types.isProxy(list) || !Object.isFrozen(list) || list.length > MAX_FORM_FIELDS) fail('UNAVAILABLE')
      const seen = new Set<string>()
      fields = list.map(item => {
        const field = record(item, ['fieldId', 'label', 'componentName', 'parentId'])
        if (typeof field.fieldId !== 'string' || !FIELD_ID.test(field.fieldId) || seen.has(field.fieldId)
          || typeof field.componentName !== 'string' || !COMPONENT.test(field.componentName)
          || typeof field.label !== 'string' || field.label.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(field.label)
          || (field.parentId !== null && (typeof field.parentId !== 'string' || !FIELD_ID.test(field.parentId)))) fail('UNAVAILABLE')
        seen.add(field.fieldId)
        return Object.freeze({ fieldId: field.fieldId, label: field.label, componentName: field.componentName, parentId: field.parentId as string | null })
      })
    }
    return { outcome: row.outcome as 'ok' | 'upstream_rejected' | 'unreachable',
      form: Object.freeze({ outcome: form.outcome as YidaFormReadOutcome, fields: Object.freeze(fields) }) }
  } catch { fail('UNAVAILABLE') }
}
function view(commandId: string, outcome: YidaConnectionTestOutcome, formRead?: YidaFormReadView): YidaConnectionTestView {
  return Object.freeze({ commandId, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
    tokenRetained: false, externalWriteAttempted: false, canSend: false, ...(formRead === undefined ? {} : { formRead }) })
}
type Run = { controller: AbortController; pending: Promise<unknown>; dependencies: Set<Promise<unknown>> }
type Registration = { closed: boolean; createProbe: YidaConnectionTestRuntimeBinding['createConnectionProbe']; runs: Set<Run>; draining?: Promise<void> }

/** Owner-only, token-only connection test. Order: capture -> enabled() -> one RC authorization
 * transaction (live ACL, anchor owner/tenant, commandId, not yet initialized) -> COMMIT -> per-process
 * admission (in flight <= 1, cooldown stamped only when an exchange starts) -> enabled() again ->
 * start window -> one probe. A caller refused before COMMIT never takes the in-flight slot or stamps
 * the cooldown. */
export function createYidaConnectionTestRuntime(dependencies: YidaConnectionTestRuntimeDependencies) {
  if (!dependencies?.database || typeof dependencies.database.transaction !== 'function'
    || typeof dependencies.fetch !== 'function') fail('UNAVAILABLE')
  const transaction = dependencies.database.transaction.bind(dependencies.database) as YidaInitializationDatabase['transaction']
  const fetcher = dependencies.fetch
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  if (typeof readEnablement !== 'function') fail('UNAVAILABLE')
  const readFormFieldsEnablement = dependencies.readFormFieldsEnablement ?? (() => 'false')
  if (typeof readFormFieldsEnablement !== 'function') fail('UNAVAILABLE')
  let active: Registration | undefined, generation = 0, terminal = false, terminalDrain: Promise<void> | undefined
  // Admission limiter. Per process; only callers that already passed authorization reach it.
  let exchangeInFlight = false, lastExchangeStartedAt = Number.NEGATIVE_INFINITY
  function enabled() {
    let value: unknown
    try { value = readEnablement() } catch { fail('DISABLED') }
    if (value !== 'true') { consumeRejection(value); fail('DISABLED') }
  }
  // The form read has its own switch; asking for it while that switch is not the exact literal is DISABLED
  // before any DB work, and again right before the exchange (never a silent fall back to the plain test).
  function formFieldsEnabled(): boolean {
    let value: unknown
    try { value = readFormFieldsEnablement() } catch { return false }
    if (value === 'true') return true
    consumeRejection(value)
    return false
  }
  function drain(state: Registration): Promise<void> {
    state.closed = true
    for (const run of state.runs) run.controller.abort()
    return state.draining ??= Promise.allSettled([...state.runs].map(run => run.pending)).then(() => { if (active === state) active = undefined })
  }
  function execute(actorInput: unknown, supplied: unknown, options: unknown): Promise<YidaConnectionTestView> {
    try {
      // Capture immutable caller data synchronously, before any await/dependency.
      const actor = captureActor(actorInput), input = captureInput(supplied), caller = signal(options), state = active
      const enteredAt = Date.now()
      if (terminal || !state || state.closed) fail('INACTIVE')
      if (caller && abortGetter.call(caller)) fail('CANCELLED')
      // Fail closed before any DB work while the switch is not the exact literal.
      enabled()
      if (input.form && !formFieldsEnabled()) fail('DISABLED')
      if (state.runs.size >= MAX_RUNS) fail('UNAVAILABLE')
      const controller = new AbortController(), abort = () => controller.abort()
      if (caller) addListener.call(caller, 'abort', abort, { once: true })
      const checkpoint = () => {
        if (abortGetter.call(controller.signal) || caller && abortGetter.call(caller)) fail('CANCELLED')
        if (terminal || state.closed || active !== state) fail('INACTIVE')
      }
      const run: Run = { controller, pending: undefined!, dependencies: new Set() }
      state.runs.add(run)
      async function checked<T>(operation: () => Promise<T>): Promise<T> {
        checkpoint(); const pending = operation(); run.dependencies.add(pending)
        try { const result = await pending; checkpoint(); return result }
        finally { run.dependencies.delete(pending) }
      }
      run.pending = Promise.resolve().then(async () => {
        try {
          checkpoint()
          const commandId = await checked(() => transaction(async raw => {
            const trx: Queryable = Object.freeze({ query: (sql: string, params?: unknown[]) => checked(() => raw.query(sql, params)) })
            try { await checked(() => assertAutomationIntegrationActor(trx, actor)) }
            catch (error) {
              checkpoint()
              if (error && typeof error === 'object' && !types.isProxy(error)
                && Object.getPrototypeOf(error) === AutomationActorAuthorityError.prototype
                && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') fail('DENIED')
              fail('UNAVAILABLE')
            }
            await checked(() => lockYidaInitializationSlot(trx))
            const anchors = await trx.query('SELECT slot,command_id,owner_id,tenant_id,workspace_id FROM integration_yida_initialization_anchor WHERE slot=1')
            const anchor = anchors.rows[0]
            if (anchors.rows.length !== 1 || anchor.slot !== 1 || anchor.workspace_id !== null) fail('UNAVAILABLE')
            let anchored: string
            try { anchored = command(anchor.command_id) } catch { fail('UNAVAILABLE') }
            if (anchor.owner_id !== actor.actorId || anchor.tenant_id !== actor.tenantId) fail('DENIED')
            if (input.commandId !== anchored) fail('CONFLICT')
            // Candidate mode exists to verify a pair BEFORE it is sealed; once the slot holds an
            // initialization or an approved target, the pasted pair can no longer become generation 1.
            const results = await trx.query('SELECT slot FROM integration_yida_initializations WHERE slot=1')
            const targets = await trx.query('SELECT slot FROM integration_yida_approved_target WHERE slot=1')
            if (results.rows.length !== 0 || targets.rows.length !== 0) fail('CONFLICT')
            checkpoint(); return anchored
          }))
          // COMMITTED. No network happened above. Only now does the caller meet the limiter.
          checkpoint()
          if (exchangeInFlight) fail('CONFLICT')
          const sinceLast = elapsedSince(lastExchangeStartedAt)
          if (sinceLast >= 0 && sinceLast < YIDA_CONNECTION_TEST_COOLDOWN_MS) fail('THROTTLED')
          enabled()
          if (input.form && !formFieldsEnabled()) fail('DISABLED')
          const probe = record(state.createProbe(Object.freeze({
            // Charged to this run until the request actually settles, and aborted with it.
            fetch: ((request, init) => checked(() => fetcher(request, init))) as typeof fetch,
          })), ['probe', 'probeForm'], ['probe'])
          if (typeof probe.probe !== 'function' || types.isProxy(probe.probe)) fail('UNAVAILABLE')
          // A plugin build without probeForm cannot read the form: INACTIVE (the page names the missing component).
          if (input.form && (typeof probe.probeForm !== 'function' || types.isProxy(probe.probeForm))) fail('INACTIVE')
          // Last refusal before the exchange: a slow authorization phase never starts a late exchange.
          if (elapsedSince(enteredAt) > YIDA_CONNECTION_TEST_START_WINDOW_MS) fail('UNAVAILABLE')
          // Nothing below refuses before the exchange starts; the cooldown is stamped together with it.
          const deadline = new AbortController()
          let timedOut = false
          const abortProbe = () => deadline.abort()
          addListener.call(controller.signal, 'abort', abortProbe, { once: true })
          const timer = setTimeout(() => { timedOut = true; deadline.abort() }, YIDA_CONNECTION_TEST_BUDGET_MS)
          exchangeInFlight = true; lastExchangeStartedAt = Date.now()
          let outcome: YidaConnectionTestOutcome
          let formRead: YidaFormReadView | undefined
          try {
            // The view is decided only after the probe (and so its fetch) settled; a fetch that
            // ignores the abort keeps this run, the limiter and stop()/drain waiting.
            const credentials = { appKey: input.material.appKey, appSecret: input.material.appSecret }
            if (input.form) {
              const target = { appType: input.form.appType, formUuid: input.form.formUuid, systemToken: input.form.systemToken, userId: input.form.userId }
              const value = await checked(() => (probe.probeForm as NonNullable<YidaConnectionProbe['probeForm']>)(
                credentials, target, { signal: deadline.signal }))
              const parsed = formReceipt(value)
              outcome = parsed.outcome; formRead = parsed.form
            } else {
              const value = await checked(() => (probe.probe as YidaConnectionProbe['probe'])(credentials, { signal: deadline.signal }))
              outcome = receipt(value)
            }
          } catch (error) {
            checkpoint()
            if (!timedOut) closeError(error)
            // The deadline fired inside the exchange itself: the form was never read.
            outcome = 'timeout'
            if (input.form) formRead = Object.freeze({ outcome: 'not_attempted', fields: Object.freeze([]) })
          } finally {
            clearTimeout(timer)
            removeListener.call(controller.signal, 'abort', abortProbe)
            exchangeInFlight = false
          }
          checkpoint()
          return view(commandId, outcome, formRead)
        } catch (error) {
          try { checkpoint() } catch (control) { closeError(control) }
          closeError(error)
        } finally {
          try {
            while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])
            checkpoint()
          } finally {
            controller.abort()
            if (caller) removeListener.call(caller, 'abort', abort)
            state.runs.delete(run)
          }
        }
      })
      // Rejection subscriber: an abandoned caller promise must never become an unhandled rejection.
      void run.pending.catch(() => {})
      return run.pending as Promise<YidaConnectionTestView>
    } catch (error) {
      try { closeError(error) } catch (closed) {
        const pending = Promise.reject<YidaConnectionTestView>(closed); void pending.catch(() => {}); return pending
      }
    }
  }
  return Object.freeze({
    createPluginCapability() {
      if (terminal) fail('INACTIVE')
      const capturedGeneration = ++generation; let used = false
      return Object.freeze({ activate(binding: YidaConnectionTestRuntimeBinding): Promise<Readonly<{ stop(): Promise<void> }>> {
        try {
          if (terminal || used || generation !== capturedGeneration || active) fail('INACTIVE')
          used = true
          const parsed = record(binding, ['createConnectionProbe'])
          if (typeof parsed.createConnectionProbe !== 'function' || types.isProxy(parsed.createConnectionProbe)) fail('INPUT')
          // Registration captures one function only; no DB, token or network work, allowed while OFF.
          const state: Registration = { closed: false, createProbe: parsed.createConnectionProbe as Registration['createProbe'], runs: new Set() }
          active = state
          return Promise.resolve(Object.freeze({ stop() { if (active === state && !state.closed) ++generation; return drain(state) } }))
        } catch (error) { try { closeError(error) } catch (closed) { const pending = Promise.reject<Readonly<{ stop(): Promise<void> }>>(closed); void pending.catch(() => {}); return pending } }
      } })
    },
    test(actor: YidaConnectionTestActor, input: YidaConnectionTestInput, options: { signal?: AbortSignal } = {}) { return execute(actor, input, options) },
    // Values-free display bit for a reply the caller already authorized. Same exact-literal source as
    // enabled(); never throws and is never authority: every test() rechecks enabled() twice.
    connectionTestEnabled(): boolean {
      let value: unknown
      try { value = readEnablement() } catch { return false }
      if (value === 'true') return true
      consumeRejection(value)
      return false
    },
    // Same rule for the form-definition read (ADR addendum 2026-11-23): display bit only, never authority.
    formFieldsReadEnabled(): boolean { return formFieldsEnabled() },
    deactivate() { ++generation; return active ? drain(active) : Promise.resolve() },
    stop() { if (terminalDrain) return terminalDrain; terminal = true; ++generation; return terminalDrain = active ? drain(active) : Promise.resolve() },
  })
}
