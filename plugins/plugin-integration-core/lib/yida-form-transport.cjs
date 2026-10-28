'use strict'

const { ReadableStream, ReadableStreamDefaultReader } = require('node:stream/web')
const { types: { isProxy, isPromise } } = require('node:util')

const ENDPOINT = 'https://api.dingtalk.com/v1.0/yida/forms/instances'
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024
const MAX_RESPONSE_READS = MAX_RESPONSE_BYTES + 1
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const FIELD_ID = /^[\p{L}\p{N}_-]{1,128}$/u
const FORBIDDEN_FIELD = /(?:__proto__|prototype|constructor|password|token|appkey|appsecret|systemtoken|authoritycode|credential|secret)/i
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get
const responseRedirected = Object.getOwnPropertyDescriptor(Response.prototype, 'redirected').get
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, 'headers').get
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get
const ownErrors = new WeakMap()
const MESSAGES = Object.freeze({
  INPUT: 'Invalid form transport input',
  DISABLED: 'Form transport disabled',
  ABORTED: 'Form transport cancelled',
  RESPONSE: 'Invalid form transport response',
  TOO_LARGE: 'Form transport response exceeds limit',
  UNAVAILABLE: 'Form transport unavailable',
})

class YidaFormTransportError extends Error {
  constructor(kind = 'UNAVAILABLE') {
    const safeKind = typeof kind === 'string' && Object.hasOwn(MESSAGES, kind) ? kind : 'UNAVAILABLE'
    super(MESSAGES[safeKind])
    this.name = 'YidaFormTransportError'
    this.code = `YIDA_FORM_${safeKind}`
    ownErrors.set(this, safeKind)
  }
}

function fail(kind) { throw new YidaFormTransportError(kind) }

function record(value, required, optional = []) {
  if (!value || typeof value !== 'object' || isProxy(value)) fail('INPUT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length < required.length || keys.length > required.length + optional.length
    || required.some((key) => !Object.hasOwn(descriptors, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) fail('INPUT')
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INPUT')
    result[key] = descriptor.value
  }
  return result
}

function boundedId(value, maximum = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !CONTROL.test(value)
}

function credential(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim().length > 0
}

function aborted(signal) {
  if (!signal || typeof signal !== 'object' || isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  return signalAborted.call(signal)
}

function checkAbort(signal) { if (aborted(signal)) fail('ABORTED') }

function validateFormJson(text) {
  if (typeof text !== 'string' || text.length > MAX_REQUEST_BYTES
    || Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) fail('INPUT')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INPUT')
  const keys = Object.keys(parsed)
  if (keys.length < 1 || keys.length > 32) fail('INPUT')
  for (const key of keys) {
    if (!FIELD_ID.test(key) || FORBIDDEN_FIELD.test(key)) fail('INPUT')
    const value = parsed[key]
    if (typeof value === 'string') {
      if (value.length > 4096) fail('INPUT')
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail('INPUT')
    } else if (typeof value !== 'boolean') fail('INPUT')
  }
  // JSON.parse would silently collapse repeated field names. Scan the already
  // validated flat JSON for duplicate keys, including equivalent escape forms.
  const strings = /"(?:[^"\\]|\\[\s\S])*"/g
  const seen = new Set()
  let match
  while ((match = strings.exec(text))) {
    let after = strings.lastIndex
    while (after < text.length && /\s/.test(text[after])) after += 1
    if (text[after] !== ':') continue
    const key = JSON.parse(match[0])
    if (seen.has(key) || seen.size >= 32) fail('INPUT')
    seen.add(key)
  }
}

function inputRequest(input) {
  const request = record(input, ['intent', 'data', 'accessToken', 'systemToken', 'userId'])
  if (request.intent !== 'create' && request.intent !== 'update') fail('INPUT')
  if (!boundedId(request.accessToken, 8192) || !credential(request.systemToken, 4096)
    || !credential(request.userId, 128)) fail('INPUT')
  const data = request.intent === 'create'
    ? record(request.data, ['appType', 'formUuid', 'formDataJson'])
    : record(request.data, ['appType', 'formInstanceId', 'updateFormDataJson'])
  if (!boundedId(data.appType) || !boundedId(request.intent === 'create' ? data.formUuid : data.formInstanceId)) fail('INPUT')
  validateFormJson(request.intent === 'create' ? data.formDataJson : data.updateFormDataJson)
  const body = JSON.stringify({ ...data, systemToken: request.systemToken, userId: request.userId })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) fail('INPUT')
  return { intent: request.intent, data, accessToken: request.accessToken, body }
}

function cancelBody(response) {
  try {
    if (isProxy(response)) return
    const body = responseBody.call(response)
    if (body) Promise.resolve(ReadableStream.prototype.cancel.call(body)).catch(() => {})
  } catch { /* Detached cleanup is best effort, never a physical termination guarantee. */ }
}

function cancelReader(reader) {
  try { Promise.resolve(ReadableStreamDefaultReader.prototype.cancel.call(reader)).catch(() => {}) } catch { /* Already released or errored. */ }
}

function inspectResponse(response) {
  if (!response || typeof response !== 'object' || isProxy(response)
    || Object.getPrototypeOf(response) !== Response.prototype) fail('RESPONSE')
  const statusCode = responseStatus.call(response)
  const redirected = responseRedirected.call(response)
  const shadowRedirect = Object.getOwnPropertyDescriptor(response, 'redirected')
  for (const field of ['status', 'headers', 'body']) if (Object.hasOwn(response, field)) fail('RESPONSE')
  if (shadowRedirect && (!Object.hasOwn(shadowRedirect, 'value') || typeof shadowRedirect.value !== 'boolean')) fail('RESPONSE')
  if (redirected || shadowRedirect?.value || statusCode < 200 || statusCode > 299) fail('RESPONSE')
  const declared = Headers.prototype.get.call(responseHeaders.call(response), 'content-length')
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) fail('RESPONSE')
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) fail('TOO_LARGE')
  }
  return { statusCode, body: responseBody.call(response) }
}

function decode(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('RESPONSE') }
}

function createYidaFormTransport(options) {
  let fetchImpl
  let readEnablement
  try {
    const settings = record(options, ['fetch'], ['readEnablement'])
    fetchImpl = settings.fetch
    readEnablement = Object.hasOwn(settings, 'readEnablement') ? settings.readEnablement : () => undefined
    if (typeof fetchImpl !== 'function' || typeof readEnablement !== 'function') fail('INPUT')
  } catch { fail('INPUT') }

  async function send(input, options) {
    let request
    let signal
    try {
      request = inputRequest(input)
      ;({ signal } = record(options, ['signal']))
      aborted(signal)
    } catch { fail('INPUT') }
    checkAbort(signal)
    let enabled
    try { enabled = readEnablement() } catch { fail('DISABLED') }
    if (enabled !== 'true') {
      // Observe only ordinary local Promises: Promise#then consults species.
      // Do not run dependency-owned constructor getters or claim to sanitize
      // hostile asynchronous work that a dependency has already launched.
      try {
        if (isPromise(enabled) && !isProxy(enabled)
          && Object.getPrototypeOf(enabled) === Promise.prototype
          && !Object.hasOwn(enabled, 'constructor')) {
          Promise.prototype.then.call(enabled, undefined, () => {})
        }
      } catch { /* Synchronous control still fails closed below. */ }
      fail('DISABLED')
    }
    checkAbort(signal)

    let response
    let reader
    let complete = false
    const abort = () => { if (reader) cancelReader(reader); else if (response) cancelBody(response) }
    EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
    try {
      checkAbort(signal)
      // Keep the actual await pending if fetch ignores cancellation. The runner
      // retains BUSY until this single attempt really settles; never retry it.
      const pending = fetchImpl(ENDPOINT, {
        method: request.intent === 'create' ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          'x-acs-dingtalk-access-token': request.accessToken,
        },
        body: request.body,
        redirect: 'error',
        signal,
      })
      if (isProxy(pending)) fail('RESPONSE')
      // Real fetch returns a native Promise. A direct synthetic Response must
      // not be assimilated as an arbitrary caller-controlled thenable.
      response = isPromise(pending) ? await pending : pending
      checkAbort(signal)
      let inspected
      try { inspected = inspectResponse(response) } catch (error) {
        if (ownErrors.has(error)) throw error
        fail('RESPONSE')
      }
      const chunks = []
      let byteLength = 0
      if (inspected.body !== null) {
        reader = ReadableStream.prototype.getReader.call(inspected.body)
        let reads = 0
        while (true) {
          checkAbort(signal)
          if (reads >= MAX_RESPONSE_READS) fail('TOO_LARGE')
          reads += 1
          const { done, value } = await ReadableStreamDefaultReader.prototype.read.call(reader)
          checkAbort(signal)
          if (done) break
          if (isProxy(value) || !(value instanceof Uint8Array)) fail('RESPONSE')
          const chunkLength = typedArrayByteLength.call(value)
          byteLength += chunkLength
          if (byteLength > MAX_RESPONSE_BYTES) fail('TOO_LARGE')
          if (chunkLength > 0) {
            const chunk = new Uint8Array(chunkLength)
            Uint8Array.prototype.set.call(chunk, value)
            chunks.push(chunk)
          }
        }
      }
      const text = decode(chunks, byteLength)
      let instanceId = request.data.formInstanceId
      if (request.intent === 'create') {
        let parsed
        try { parsed = JSON.parse(text) } catch { fail('RESPONSE') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('RESPONSE')
        instanceId = Object.getOwnPropertyDescriptor(parsed, 'result')?.value
        if (!boundedId(instanceId)) fail('RESPONSE')
      }
      // Update has no modeled result. Even an error-looking 2xx body is only an
      // HTTP ACK here, never verified business success or remote ID agreement.
      checkAbort(signal)
      complete = true
      return { statusCode: inspected.statusCode, instanceId }
    } catch (error) {
      throw new YidaFormTransportError(aborted(signal) ? 'ABORTED' : ownErrors.get(error) || 'UNAVAILABLE')
    } finally {
      EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      if (!complete) { if (reader) cancelReader(reader); else if (response) cancelBody(response) }
      if (reader) { try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader) } catch { /* Already released. */ } }
    }
  }
  return Object.freeze({ send })
}

module.exports = { createYidaFormTransport, YidaFormTransportError }
