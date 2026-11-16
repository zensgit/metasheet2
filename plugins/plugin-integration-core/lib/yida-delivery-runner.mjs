import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import deliveryStore from './yida-delivery-store.cjs'
import executionDigest from './yida-execution-digest.cjs'
import formProtocol from './yida-form-transport.cjs'
import sendBudget from './yida-send-budget.cjs'
import { buildYidaStaticPlan } from './yida-static-plan.mjs'

// Internal mechanism only. The injected resolver is a future trusted authority
// boundary, NOT evidence of owner approval. No runtime consumer is registered.
const { deepCloneFrozenCanonical, stableCanonicalStringify } = canonical
const { createYidaDeliveryStore } = deliveryStore
const { buildYidaExecutionPayloadDigest } = executionDigest
const { YidaFormTransportError } = formProtocol
const { boundYidaExecutionSnapshot, YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH, YIDA_SEND_USER_ID_MAX_LENGTH } = sendBudget
const CONTEXT_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'actorId']
const SNAPSHOT_KEYS = [
  ...CONTEXT_KEYS, 'operationId', 'rowKey', 'grantRef', 'expiresAt', 'targetRef',
  'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration',
  'config', 'row', 'systemToken', 'userId', 'instanceId',
]
const ERROR_CODES = new Set([
  'INVALID_INPUT', 'DISABLED', 'BUSY', 'CANCELLED', 'TIMEOUT', 'CLOCK_INVALID',
  'SNAPSHOT_INVALID', 'SNAPSHOT_CHANGED', 'SNAPSHOT_EXPIRED', 'PREPARE_FAILED',
  'TOKEN_FAILED', 'CLAIM_UNCONFIRMED',
].map((code) => `YIDA_RUN_${code}`))
const ID_RE = /^[^\u0000-\u001f\u007f]+$/u
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

// Gate 4 (R-71 ⑦.2): the snapshot budget is defined once in yida-send-budget.cjs and shared with the
// pre-admission assessment. Every failure there is SNAPSHOT_INVALID here, exactly as before.
function boundedSnapshot(value) {
  try { return boundYidaExecutionSnapshot(value) } catch { fail('SNAPSHOT_INVALID') }
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
  privateText(snapshot.systemToken, YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH)
  privateText(snapshot.userId, YIDA_SEND_USER_ID_MAX_LENGTH)
  // R-71 ⑦.3: a v2 or a v3 mapping (exact numbers). The single row is planned again from the
  // snapshot's own config; the data must still equal the approved execution digest below.
  if (!snapshot.config || ![2, 3].includes(snapshot.config.version)) fail('SNAPSHOT_INVALID')
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

function receiptReason(error) {
  // A dependency can throw any JS value. Never let inspection of that value
  // bypass the claimed-attempt cleanup or leak an upstream exception.
  try {
    if (types.isProxy(error) || !(error instanceof YidaFormTransportError)) return 'transport_unknown'
    // Non-2xx, redirect or not a Response at all: the remote refused or never answered properly.
    if (error.code === 'YIDA_FORM_RESPONSE') return 'receipt_invalid'
    // Gate 6 (R-71 ⑦.1, owner choice a2): a 2xx status line WAS received but its body could not be
    // used (not UTF-8 / not JSON / no result / over the 16 KiB cap / errored or stalled stream).
    // The ledger keeps that fact as its own reason; the row is still outcome_unknown, never resent.
    if (error.code === 'YIDA_FORM_RECEIPT' || error.code === 'YIDA_FORM_TOO_LARGE') return 'receipt_unparsed'
    return 'transport_unknown'
  } catch { return 'transport_unknown' }
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
      try { claim = await store.claim({ ...scope, actorId: context.actorId }) } catch { fail('CLAIM_UNCONFIRMED') }
      const finish = { ...scope, actorId: context.actorId, claimToken: claim.claimToken }
      async function unknown(reason) {
        try { return result(await store.markUnknown({ ...finish, reason }), externalWriteAttempted) } catch {
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
        // Gate 6 (R-71 ⑦.1): no check() after send. A receipt the transport returned is evidence
        // that the remote answered 2xx; a stop code, switch flip or expiry that arrived while the
        // body was being read cannot turn it into transport_unknown. The timer still tears the
        // request down BEFORE the status line (the transport forwards the signal only until then).
      } catch (error) {
        return await unknown(receiptReason(error))
      }
      const ack = validReceipt(receipt, fixed)
      if (!ack) return await unknown('receipt_invalid')
      try {
        // Once an ACK commit is known, cancellation cannot undo durable history.
        return result(await store.recordAcknowledgement({ ...finish, ack }), true)
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
