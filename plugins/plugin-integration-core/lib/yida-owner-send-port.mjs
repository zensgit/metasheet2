import { types } from 'node:util'
import tokenClientModule from './yida-token-client.cjs'
import tokenExchangeModule from './yida-token-exchange.cjs'
import formTransportModule from './yida-form-transport.cjs'
import { createYidaDeliveryRunner } from './yida-delivery-runner.mjs'

// Host-private, still unregistered. The host supplies the actual core authority
// factory; request bodies cannot supply this dependency, fetch or enablement.
// Only a fresh confirmed admission can construct a runner/token/transport.
// Replayed submissions observe durable history, including prepared/unknown,
// rather than recovering a second execution credential after a process crash.
const CODES = new Set(['INPUT', 'DISABLED', 'UNAVAILABLE', 'CANCELLED'])
const ownErrors = new WeakMap()
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId', 'actorId']
const STATES = new Set(['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'])
const METADATA = ['grantId', 'operationId', 'rowKey', 'targetRef', 'approvedAt', 'expiresAt',
  'maxAttempts', 'remainingAttempts', 'status', 'revoked', 'admissionId', 'ledgerId', 'canSend', 'externalWriteAttempted']
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get

export class YidaOwnerSendError extends Error {
  constructor(code) {
    const fixed = CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_OWNER_SEND_${fixed}`)
    this.name = 'YidaOwnerSendError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaOwnerSendError(code) }
function closed(error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
function record(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT')
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(properties, key))) fail('INPUT')
  const result = Object.create(null)
  for (const key of Object.keys(properties)) {
    const property = properties[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    result[key] = property.value
  }
  return result
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function signalOf(options) {
  const { signal } = record(options, ['signal'], [])
  if (signal === undefined) return undefined
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  try { aborted.call(signal) } catch { fail('INPUT') }
  return signal
}
function cancellation(signal) { if (signal !== undefined && aborted.call(signal)) fail('CANCELLED') }
function observePromise(value) {
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* Asynchronous control is never enablement. */ }
}
function deliveryView(value) {
  if (value === null) return null
  const row = record(value, ['id', 'status', 'durable'])
  if (!STATES.has(row.status) || row.durable !== true) fail('UNAVAILABLE')
  return Object.freeze({ id: id(row.id), status: row.status, durable: true })
}
function metadata(value, grantId, withReuse = false) {
  const parsed = record(value, withReuse ? [...METADATA, 'reused'] : METADATA)
  if (!Object.isFrozen(value) || parsed.grantId !== grantId || parsed.canSend !== false
    || parsed.externalWriteAttempted !== false || (withReuse && ![true, false].includes(parsed.reused))) fail('UNAVAILABLE')
  return value
}
function build(options) {
  const config = record(options, ['db', 'context', 'authority', 'fetch', 'readEnablement', 'timeoutMs'],
    ['db', 'context', 'authority', 'fetch'])
  const scope = record(config.context, CONTEXT)
  for (const key of CONTEXT) if (key !== 'workspaceId') id(scope[key])
  if (scope.workspaceId !== null || scope.actorId !== scope.ownerId) fail('INPUT')
  Object.freeze(scope)
  if (!config.db || typeof config.fetch !== 'function' || !config.authority
    || ['admitForExecution', 'takeExecution', 'observe'].some(key => typeof config.authority[key] !== 'function')) fail('INPUT')
  const readEnablement = Object.hasOwn(config, 'readEnablement') ? config.readEnablement : () => 'false'
  const timeoutMs = Object.hasOwn(config, 'timeoutMs') ? config.timeoutMs : 10000
  if (typeof readEnablement !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) fail('INPUT')
  function enabled() {
    let value
    try { value = readEnablement() } catch { fail('DISABLED') }
    if (value !== 'true') { observePromise(value); fail('DISABLED') }
  }
  async function observe(grantId) {
    const observed = record(await config.authority.observe({ grantId }), ['approval', 'delivery'])
    // The actual core authority owns and freezes this metadata. Its public
    // projection contains neither material, plan data nor execution permits.
    return Object.freeze({ approval: metadata(observed.approval, grantId), delivery: deliveryView(observed.delivery) })
  }
  async function inspect(input) {
    try { return await observe(id(record(input, ['grantId']).grantId)) } catch (error) { closed(error) }
  }
  async function submit(input, options = {}) {
    let handle, client
    try {
      const parsed = record(input, ['grantId', 'submissionId'])
      const grantId = id(parsed.grantId), submissionId = id(parsed.submissionId), signal = signalOf(options)
      cancellation(signal); enabled()
      const admitted = record(await config.authority.admitForExecution({ grantId, submissionId }), ['approval', 'permit'])
      cancellation(signal); enabled()
      const approval = metadata(admitted.approval, grantId, true)
      if (approval.reused) {
        if (admitted.permit !== null) fail('UNAVAILABLE')
        const history = await observe(grantId)
        return Object.freeze({ ...history, reused: true, status: history.delivery?.status ?? 'not_started',
          externalWriteAttempted: false, businessVerified: false, durable: true })
      }
      // No interpretation of ordinary metadata can mint a permit. This is the
      // real private factory's synchronous, one-use WeakMap identity check.
      handle = config.authority.takeExecution(admitted.permit)
      for (const key of CONTEXT) if (handle.context[key] !== scope[key]) fail('UNAVAILABLE')
      if (handle.operation.operationId !== approval.operationId || handle.operation.rowKey !== approval.rowKey) fail('UNAVAILABLE')
      cancellation(signal); enabled()
      const actualExchange = tokenExchangeModule.createDingTalkAppTokenExchange({ fetch: config.fetch })
      const exchangeToken = async (material, options) => {
        // A token request is external IO too. Recheck the literal switch after
        // the potentially slow live authority/material transaction, not only
        // before starting the runner. This does not claim atomic socket revoke.
        cancellation(options.signal); enabled()
        return actualExchange(material, options)
      }
      client = tokenClientModule.createYidaTokenClient({ loadCredential: handle.loadCredential, exchangeToken,
        maxBindings: 1, maxOutstandingFlights: 1, maxWaitersPerFlight: 1, refreshTimeoutMs: timeoutMs })
      client.activate(handle.credentialBinding)
      const transport = formTransportModule.createYidaFormTransport({ fetch: config.fetch, readEnablement })
      const runner = createYidaDeliveryRunner({ db: config.db, context: handle.context,
        resolveExecutionSnapshot: handle.resolveExecutionSnapshot, tokenClient: client,
        formTransport: transport, readEnablement, timeoutMs })
      const execution = await runner.run(handle.operation, signal === undefined ? {} : { signal })
      const history = await observe(grantId)
      if (![...STATES, 'state_unconfirmed'].includes(execution.status) || typeof execution.durable !== 'boolean'
        || typeof execution.externalWriteAttempted !== 'boolean' || execution.businessVerified !== false) fail('UNAVAILABLE')
      if (execution.durable && (history.delivery?.id !== approval.ledgerId || history.delivery?.status !== execution.status)) fail('UNAVAILABLE')
      return Object.freeze({ ...history, reused: false, status: execution.status,
        externalWriteAttempted: execution.externalWriteAttempted, businessVerified: false, durable: execution.durable })
    } catch (error) { closed(error) }
    finally {
      // Failed construction/late cancellation must not leave a reusable private
      // handle. Cleanup never rewrites prepared/unknown or refunds the grant.
      try { handle?.close() } catch { /* Only the actual host owns the handle. */ }
      try { if (client) await client.disposeAndDrain() } catch { /* No dependency error escapes cleanup. */ }
    }
  }
  return Object.freeze({ submit, inspect })
}
export function createYidaOwnerSendPort(options) {
  try { return build(options) } catch (error) { closed(error) }
}
