import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import deliveryStore from './yida-delivery-store.cjs'
import executionDigest from './yida-execution-digest.cjs'
import formProtocol from './yida-form-transport.cjs'
import tokenClientModule from './yida-token-client.cjs'
import tokenExchangeModule from './yida-token-exchange.cjs'
import { buildYidaStaticPlan } from './yida-static-plan.mjs'

// Internal mechanism only. The resolver/authority must be supplied by the
// trusted host, not public input. This module registers no runtime consumer.
const { deepCloneFrozenCanonical, stableCanonicalStringify } = canonical
const { createYidaDeliveryStore } = deliveryStore
const { buildYidaExecutionPayloadDigest } = executionDigest
const { YidaFormTransportError } = formProtocol
const CONTEXT_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'actorId']
const SNAPSHOT_KEYS = [
  ...CONTEXT_KEYS, 'operationId', 'rowKey', 'grantRef', 'expiresAt', 'targetRef',
  'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration',
  'config', 'row', 'systemToken', 'userId', 'instanceId',
]
const ERROR_CODES = new Set([
  'INVALID_INPUT', 'DISABLED', 'BUSY', 'CANCELLED', 'TIMEOUT', 'CLOCK_INVALID',
  'SNAPSHOT_INVALID', 'SNAPSHOT_CHANGED', 'SNAPSHOT_EXPIRED', 'PREPARE_FAILED',
  'TOKEN_FAILED', 'CLAIM_UNCONFIRMED', 'STOP_FAILED',
].map((code) => `YIDA_RUN_${code}`))
const ID_RE = /^[^\u0000-\u001f\u007f]+$/u
const MAX_BYTES = 256 * 1024
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener

export class YidaDeliveryRunError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code) ? code : 'YIDA_RUN_INVALID_INPUT'
    super(safeCode)
    this.name = 'YidaDeliveryRunError'
    this.code = safeCode
  }
}

function fail(code) { throw new YidaDeliveryRunError(`YIDA_RUN_${code}`) }

function observeAccidentalPromise(value) {
  // Only ordinary local Promises may be observed. Promise#then consults the
  // constructor/species; a dependency-owned accessor must not run here. This
  // is fixed-error hygiene, not authority or malicious-process isolation.
  try {
    if (types.isPromise(value) && !types.isProxy(value)
      && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) {
      Promise.prototype.then.call(value, undefined, () => {})
    }
  } catch { /* Invalid asynchronous control values remain rejected below. */ }
}

function dataObject(value, keys, required = keys, code = 'INVALID_INPUT') {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail(code)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const parsed = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    const property = descriptors[key]
    if (typeof key !== 'string' || !keys.includes(key) || !property.enumerable || !('value' in property)) fail(code)
    parsed[key] = property.value
  }
  if (required.some((key) => !Object.hasOwn(parsed, key))) fail(code)
  return parsed
}

function opaque(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value.trim() !== value || !ID_RE.test(value)) fail(code)
  return value
}

function privateText(value, max) {
  if (typeof value !== 'string' || value.length > max || value.trim() === '') fail('SNAPSHOT_INVALID')
}

function callerSignal(options) {
  const parsed = dataObject(options, ['signal'], [])
  if (parsed.signal === undefined) return null
  const signal = parsed.signal
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INVALID_INPUT')
  try { abortedGetter.call(signal) } catch { fail('INVALID_INPUT') }
  return signal
}

// Bound the raw strict domain BEFORE canonical cloning (which normalizes -0).
function boundedSnapshot(value) {
  let nodes = 0
  let bytes = 0
  const ancestors = new Set()
  function visit(entry, depth) {
    if (++nodes > 4096 || depth > 12) fail('SNAPSHOT_INVALID')
    if (entry === null || typeof entry === 'boolean') return
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail('SNAPSHOT_INVALID')
      return
    }
    if (typeof entry === 'string') {
      bytes += Buffer.byteLength(entry, 'utf8')
      if (bytes > MAX_BYTES) fail('SNAPSHOT_INVALID')
      return
    }
    if (!entry || typeof entry !== 'object' || types.isProxy(entry) || ancestors.has(entry)) fail('SNAPSHOT_INVALID')
    const array = Array.isArray(entry)
    const proto = Object.getPrototypeOf(entry)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('SNAPSHOT_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > 4097) fail('SNAPSHOT_INVALID')
    if (array && (keys.length !== entry.length + 1 || entry.length > 4096)) fail('SNAPSHOT_INVALID')
    ancestors.add(entry)
    for (const key of keys) {
      if (array && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !('value' in property)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length))) fail('SNAPSHOT_INVALID')
      bytes += Buffer.byteLength(key, 'utf8')
      if (bytes > MAX_BYTES) fail('SNAPSHOT_INVALID')
      visit(property.value, depth + 1)
    }
    ancestors.delete(entry)
  }
  visit(value, 0)
  try {
    const serialized = stableCanonicalStringify(value)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) fail('SNAPSHOT_INVALID')
    return { snapshot: deepCloneFrozenCanonical(value), serialized }
  } catch { fail('SNAPSHOT_INVALID') }
}

function compileSnapshot(raw, identity) {
  const bounded = boundedSnapshot(raw)
  const snapshot = bounded.snapshot
  const parsed = dataObject(snapshot, SNAPSHOT_KEYS, SNAPSHOT_KEYS.filter((key) => key !== 'instanceId'), 'SNAPSHOT_INVALID')
  for (const key of [...CONTEXT_KEYS, 'operationId', 'rowKey', 'grantRef', 'targetRef',
    'targetRevision', 'planRevision', 'credentialRef']) {
    if (key === 'workspaceId' && parsed[key] === null) continue
    opaque(parsed[key], 'SNAPSHOT_INVALID')
  }
  for (const key of Object.keys(identity)) {
    if (snapshot[key] !== identity[key]) fail('SNAPSHOT_INVALID')
  }
  if (!Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt < 1
    || !Number.isSafeInteger(snapshot.credentialGeneration) || snapshot.credentialGeneration < 1
    || snapshot.credentialGeneration > 2147483647) fail('SNAPSHOT_INVALID')
  privateText(snapshot.systemToken, 4096)
  privateText(snapshot.userId, 128)
  if (!snapshot.config || snapshot.config.version !== 2) fail('SNAPSHOT_INVALID')
  let plan
  try { plan = buildYidaStaticPlan({ config: snapshot.config, rows: [snapshot.row] }) } catch { fail('SNAPSHOT_INVALID') }
  const planned = plan.rows[0]
  const intent = snapshot.config.intent
  if (plan.rows.length !== 1 || planned.status !== `planned_${intent}` || planned.issues.length !== 0
    || !planned.protocolPreview || typeof planned.localBusinessKey !== 'string') fail('SNAPSHOT_INVALID')
  if (intent === 'update') {
    opaque(snapshot.instanceId, 'SNAPSHOT_INVALID')
    if (snapshot.instanceId !== planned.instanceId) fail('SNAPSHOT_INVALID')
  } else if (intent !== 'create' || Object.hasOwn(snapshot, 'instanceId')) fail('SNAPSHOT_INVALID')
  const innerJson = stableCanonicalStringify(planned.payload)
  const data = deepCloneFrozenCanonical({
    ...planned.protocolPreview.data,
    [intent === 'create' ? 'formDataJson' : 'updateFormDataJson']: innerJson,
  })
  const payloadDigest = buildYidaExecutionPayloadDigest({ snapshot, intent, data })
  const businessKeyDigest = createHash('sha256').update(planned.localBusinessKey).digest('hex')
  return { ...bounded, intent, data, payloadDigest, businessKeyDigest }
}

function validReceipt(receipt, fixed) {
  try {
    const parsed = dataObject(receipt, ['statusCode', 'instanceId'])
    opaque(parsed.instanceId)
    if (!Number.isInteger(parsed.statusCode) || parsed.statusCode < 200 || parsed.statusCode > 299
      || (fixed.intent === 'update' && parsed.instanceId !== fixed.snapshot.instanceId)) return null
    return Object.freeze({ statusCode: parsed.statusCode, instanceId: parsed.instanceId })
  } catch { return null }
}

function receiptFailure(error) {
  // A dependency can throw any JS value. Never let inspection of that value
  // bypass the claimed-attempt cleanup or leak an upstream exception.
  try {
    return !types.isProxy(error) && error instanceof YidaFormTransportError
      && (error.code === 'YIDA_FORM_RESPONSE' || error.code === 'YIDA_FORM_TOO_LARGE')
  } catch { return false }
}

function result(record, externalWriteAttempted, durable = true) {
  return Object.freeze({
    status: durable ? record.status : 'state_unconfirmed', externalWriteAttempted,
    businessVerified: false, durable, record,
  })
}

export function createYidaDeliveryRunner(options) {
  const config = dataObject(options, [
    'db', 'context', 'resolveExecutionSnapshot', 'tokenClient', 'formTransport',
    'readEnablement', 'wallClock', 'timeoutMs',
  ], ['db', 'context', 'resolveExecutionSnapshot', 'tokenClient', 'formTransport'])
  const parsedContext = dataObject(config.context, CONTEXT_KEYS)
  for (const key of CONTEXT_KEYS) {
    if (key === 'workspaceId' && parsedContext[key] === null) continue
    opaque(parsedContext[key])
  }
  if (parsedContext.actorId !== parsedContext.ownerId) fail('INVALID_INPUT')
  const context = Object.freeze({ ...parsedContext })
  return createDeliveryKernel(config, context)
}

// The mechanism is shared; neither ordinary caller options nor a scope object
// select the delegated path. Its separate private entry consumes the host's
// instance-local, known-COMMIT capability before any token/transport exists.
function createDeliveryKernel(config, context) {
  const resolveExecutionSnapshot = config.resolveExecutionSnapshot
  const readEnablement = config.readEnablement === undefined ? () => 'false' : config.readEnablement
  const wallClock = config.wallClock === undefined ? Date.now : config.wallClock
  const timeoutMs = config.timeoutMs === undefined ? 10000 : config.timeoutMs
  let getAccessToken
  let send
  let store
  try {
    getAccessToken = config.tokenClient.getAccessToken.bind(config.tokenClient)
    send = config.formTransport.send.bind(config.formTransport)
    store = createYidaDeliveryStore({ db: config.db })
  } catch { fail('INVALID_INPUT') }
  // Only the separate private constructor can supply terminal. The public
  // manual options whitelist rejects this field and retains the original store.
  const terminal = config.terminal === undefined ? store : config.terminal
  if (typeof resolveExecutionSnapshot !== 'function' || typeof readEnablement !== 'function'
    || typeof wallClock !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('INVALID_INPUT')
  let busy = false
  let lastClock = -Infinity

  function enabled() {
    let value
    try { value = readEnablement() } catch { fail('DISABLED') }
    if (value !== 'true') {
      // Async enablement is never authority, but must not leak a rejection.
      observeAccidentalPromise(value)
      fail('DISABLED')
    }
  }

  function unexpired(snapshot) {
    let now
    try { now = wallClock() } catch { fail('CLOCK_INVALID') }
    observeAccidentalPromise(now)
    if (typeof now !== 'number' || !Number.isFinite(now) || now < lastClock) fail('CLOCK_INVALID')
    lastClock = now
    if (snapshot.expiresAt <= now) fail('SNAPSHOT_EXPIRED')
  }

  async function run(input, options = {}) {
    const parsed = dataObject(input, ['operationId', 'rowKey'])
    const operationId = opaque(parsed.operationId)
    const rowKey = opaque(parsed.rowKey)
    const caller = callerSignal(options)
    if (caller && abortedGetter.call(caller)) fail('CANCELLED')
    if (busy) fail('BUSY')
    busy = true
    const controller = new AbortController()
    let stopCode = null
    function stop(code) {
      if (!stopCode) {
        stopCode = code
        controller.abort()
      }
    }
    const onAbort = () => stop('CANCELLED')
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    if (caller) addListener.call(caller, 'abort', onAbort, { once: true })
    if (caller && abortedGetter.call(caller)) onAbort()
    const identity = Object.freeze({ ...context, operationId, rowKey })
    const scope = Object.freeze({ tenantId: context.tenantId, workspaceId: context.workspaceId,
      ownerId: context.ownerId, operationId, rowKey })
    const signalOptions = Object.freeze({ signal: controller.signal })
    function check(snapshot) {
      if (stopCode) fail(stopCode)
      enabled()
      if (snapshot) unexpired(snapshot)
      if (stopCode) fail(stopCode)
    }
    async function resolve(expected) {
      let raw
      try { raw = await resolveExecutionSnapshot(identity, signalOptions) } catch {
        check()
        fail('SNAPSHOT_INVALID')
      }
      check()
      const fixed = compileSnapshot(raw, identity)
      check(fixed.snapshot)
      if (expected && expected.serialized !== fixed.serialized) fail('SNAPSHOT_CHANGED')
      return fixed
    }
    let externalWriteAttempted = false
    try {
      check()
      const fixed = await resolve()
      check(fixed.snapshot)
      const snapshot = fixed.snapshot
      let prepared
      try {
        prepared = await store.prepare({
          ...scope, targetRef: snapshot.targetRef, targetRevision: snapshot.targetRevision,
          planRevision: snapshot.planRevision, payloadDigest: fixed.payloadDigest,
          businessKeyDigest: fixed.businessKeyDigest, credentialRef: snapshot.credentialRef,
          credentialGeneration: snapshot.credentialGeneration, intent: fixed.intent,
          ...(fixed.intent === 'update' ? { instanceId: snapshot.instanceId } : {}),
        })
      } catch { check(snapshot); fail('PREPARE_FAILED') }
      check(snapshot)
      if (prepared.record.status !== 'prepared') return result(prepared.record, false)
      let accessToken
      try {
        accessToken = await getAccessToken(Object.freeze({
          tenantId: context.tenantId, workspaceId: context.workspaceId, ownerId: context.ownerId,
          credentialRef: snapshot.credentialRef, credentialGeneration: snapshot.credentialGeneration,
        }), signalOptions)
      } catch { check(snapshot); fail('TOKEN_FAILED') }
      check(snapshot)
      if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8192
        || accessToken.trim() !== accessToken || !ID_RE.test(accessToken)) fail('TOKEN_FAILED')
      await resolve(fixed)
      check(snapshot)
      let claim
      // Await the real commit, including after cancellation: a late claim token
      // must be retained for cleanup, not abandoned by a Promise.race.
      try { claim = await terminal.claim({ ...scope, actorId: context.actorId }) } catch { fail('CLAIM_UNCONFIRMED') }
      const finish = { ...scope, actorId: context.actorId, claimToken: claim.claimToken }
      async function unknown(reason) {
        try { return result(await terminal.markUnknown({ ...finish, reason }), externalWriteAttempted) } catch {
          return result(null, externalWriteAttempted, false)
        }
      }
      try {
        check(snapshot)
        await resolve(fixed)
        check(snapshot)
      } catch { return await unknown('manual_recovery') }
      let receipt
      try {
        externalWriteAttempted = true
        receipt = await send(Object.freeze({ intent: fixed.intent, data: fixed.data,
          accessToken, systemToken: snapshot.systemToken, userId: snapshot.userId }), signalOptions)
        check(snapshot)
      } catch (error) {
        return await unknown(receiptFailure(error) ? 'receipt_invalid' : 'transport_unknown')
      }
      const ack = validReceipt(receipt, fixed)
      if (!ack) return await unknown('receipt_invalid')
      try {
        // Once an ACK commit is known, cancellation cannot undo durable history.
        return result(await terminal.recordAcknowledgement({ ...finish, ack }), true)
      } catch {
        let observed
        try { observed = await store.get(scope) } catch { /* Unknown readback is not proof of rollback. */ }
        if (observed?.status === 'acknowledged') return result(observed, true)
        return await unknown('commit_unknown')
      }
    } finally {
      clearTimeout(timer)
      if (caller) removeListener.call(caller, 'abort', onAbort)
      busy = false
    }
  }
  return Object.freeze({ run })
}

/** Host-private, one-attempt mechanism; NOT a registered action or public API.
 * The trusted host installs the actual core authority. No protection against
 * arbitrary malicious same-process code is claimed by dependency injection. */
export function createInternalYidaAutomationSendAttempt(options) {
  let handle
  try {
    const config = dataObject(options, ['db', 'context', 'authority', 'permit', 'fetch',
      'readEnablement', 'wallClock', 'timeoutMs'], ['db', 'context', 'authority', 'permit', 'fetch'])
    const parsedContext = dataObject(config.context, CONTEXT_KEYS)
    for (const key of CONTEXT_KEYS) {
      if (key === 'workspaceId' && parsedContext[key] === null) continue
      opaque(parsedContext[key])
    }
    if (parsedContext.workspaceId !== null || parsedContext.actorId === parsedContext.ownerId
      || typeof config.fetch !== 'function' || typeof config.authority?.takeExecution !== 'function') fail('INVALID_INPUT')
    const context = Object.freeze({ ...parsedContext })
    const readEnablement = config.readEnablement === undefined ? () => 'false' : config.readEnablement
    const timeoutMs = config.timeoutMs === undefined ? 10000 : config.timeoutMs
    if (typeof readEnablement !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000
      || (config.wallClock !== undefined && typeof config.wallClock !== 'function')) fail('INVALID_INPUT')
    handle = config.authority.takeExecution(config.permit)
    if (!handle || CONTEXT_KEYS.some(key => handle.context[key] !== context[key])
      || ['resolveExecutionSnapshot', 'loadCredential', 'assertActive', 'claim', 'recordAcknowledgement', 'markUnknown', 'close']
        .some(key => typeof handle[key] !== 'function')) fail('INVALID_INPUT')
    const operation = dataObject(handle.operation, ['operationId', 'rowKey'])
    opaque(operation.operationId); opaque(operation.rowKey)
    let used = false
    async function run(options = {}) {
      // Even pre-token failure consumes this attempt; no retry by reusing a
      // prepared ledger/handle after a token fault or uncertain process result.
      if (used) fail('INVALID_INPUT')
      used = true
      let client
      try {
        const caller = callerSignal(options)
        if (caller && abortedGetter.call(caller)) fail('CANCELLED')
        function check(signal) {
          if (signal && abortedGetter.call(signal)) fail('CANCELLED')
          handle.assertActive()
          let enabled
          try { enabled = readEnablement() } catch { fail('DISABLED') }
          if (enabled !== 'true') { observeAccidentalPromise(enabled); fail('DISABLED') }
        }
        check(caller)
        const guardedFetch = (url, init) => {
          // A final local check directly before BOTH token and form fetch.
          // This is not an atomic network revocation or a remote undo claim.
          check(init.signal)
          return config.fetch(url, init)
        }
        const exchangeToken = tokenExchangeModule.createDingTalkAppTokenExchange({ fetch: guardedFetch })
        client = tokenClientModule.createYidaTokenClient({ loadCredential: handle.loadCredential, exchangeToken,
          maxBindings: 1, maxOutstandingFlights: 1, maxWaitersPerFlight: 1, refreshTimeoutMs: timeoutMs })
        client.activate(handle.credentialBinding)
        const transport = formProtocol.createYidaFormTransport({ fetch: guardedFetch, readEnablement })
        const kernel = createDeliveryKernel({ db: config.db, resolveExecutionSnapshot: handle.resolveExecutionSnapshot,
          tokenClient: client, formTransport: transport, terminal: handle,
          readEnablement, timeoutMs, wallClock: config.wallClock }, context)
        return await kernel.run(operation, options)
      } catch (error) {
        if (!types.isProxy(error) && error instanceof YidaDeliveryRunError) throw error
        fail('SNAPSHOT_INVALID')
      } finally {
        // Await the actual token flight drain. An unknown drain must not be
        // reported as stopped or replaced by the preceding business outcome.
        let stopFailed = false
        try { handle.close() } catch { stopFailed = true }
        try { if (client) await client.disposeAndDrain() } catch { stopFailed = true }
        if (stopFailed) fail('STOP_FAILED')
      }
    }
    return Object.freeze({ run, close() {
      used = true
      try { handle.close() } catch { fail('STOP_FAILED') }
    } })
  } catch (error) {
    try { handle?.close() } catch { /* Construction releases no usable handle. */ }
    if (error instanceof YidaDeliveryRunError) throw error
    fail('INVALID_INPUT')
  }
}
