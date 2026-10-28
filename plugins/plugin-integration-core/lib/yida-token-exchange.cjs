'use strict'

const { ReadableStream, ReadableStreamDefaultReader } = require('node:stream/web')
const { types: { isProxy } } = require('node:util')

const ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const MAX_BODY_BYTES = 16 * 1024
const MAX_BODY_READS = MAX_BODY_BYTES + 1
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get
const responseRedirected = Object.getOwnPropertyDescriptor(Response.prototype, 'redirected').get
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, 'headers').get
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get
const internalErrors = new WeakMap()
const ERROR_MESSAGES = Object.freeze({
  INPUT: 'Invalid token exchange input',
  ABORTED: 'Token exchange cancelled',
  RESPONSE: 'Invalid token exchange response',
  TOO_LARGE: 'Token exchange response exceeds limit',
  UNAVAILABLE: 'Token exchange unavailable',
})

class YidaTokenExchangeError extends Error {
  constructor(kind = 'UNAVAILABLE') {
    const safeKind = typeof kind === 'string' && Object.hasOwn(ERROR_MESSAGES, kind) ? kind : 'UNAVAILABLE'
    super(ERROR_MESSAGES[safeKind])
    this.name = 'YidaTokenExchangeError'
    this.code = `YIDA_TOKEN_EXCHANGE_${safeKind}`
    internalErrors.set(this, safeKind)
  }
}

function fail(kind) {
  throw new YidaTokenExchangeError(kind)
}

// Read descriptors, not caller getters. Symbols, extras and inherited records
// are not part of this deliberately narrow internal protocol.
function closedRecord(value, keys) {
  if (!value || typeof value !== 'object' || isProxy(value)) fail('INPUT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actualKeys = Reflect.ownKeys(descriptors)
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) fail('INPUT')
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INPUT')
    result[key] = descriptor.value
  }
  return result
}

function validCredential(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim().length > 0
}

function isAborted(signal) {
  if (!signal || typeof signal !== 'object' || isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  return abortSignalAborted.call(signal)
}

function checkAbort(signal) {
  if (isAborted(signal)) fail('ABORTED')
}

function cancelBody(response) {
  try {
    if (isProxy(response)) return
    const body = responseBody.call(response)
    if (body) Promise.resolve(ReadableStream.prototype.cancel.call(body)).catch(() => {})
  } catch {
    // Best-effort cleanup must not expose values or wait for an uncooperative source.
  }
}

function cancelReader(reader) {
  try {
    Promise.resolve(ReadableStreamDefaultReader.prototype.cancel.call(reader)).catch(() => {})
  } catch {
    // The reader may already have been released or errored.
  }
}

function validateResponse(response) {
  // Intrinsic getters brand-check an actual Response and bypass arbitrary
  // dependency accessors. A shadowed redirect flag may only tighten rejection.
  if (isProxy(response)) fail('RESPONSE')
  const status = responseStatus.call(response)
  const redirected = responseRedirected.call(response)
  const shadowRedirect = Object.getOwnPropertyDescriptor(response, 'redirected')
  for (const name of ['status', 'headers', 'body']) {
    if (Object.hasOwn(response, name)) fail('RESPONSE')
  }
  if (shadowRedirect && (!Object.hasOwn(shadowRedirect, 'value') || typeof shadowRedirect.value !== 'boolean')) fail('RESPONSE')
  if (redirected || shadowRedirect?.value || status !== 200) fail('RESPONSE')

  const declared = Headers.prototype.get.call(responseHeaders.call(response), 'content-length')
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) fail('RESPONSE')
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) fail('TOO_LARGE')
  }
  const body = responseBody.call(response)
  if (body === null) fail('RESPONSE')
  return body
}

function parseBody(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('RESPONSE')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('RESPONSE')
  const accessToken = Object.getOwnPropertyDescriptor(parsed, 'accessToken')?.value
  const expireIn = Object.getOwnPropertyDescriptor(parsed, 'expireIn')?.value
  if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8192
    || accessToken.trim() !== accessToken || /[\u0000-\u001f\u007f-\u009f]/.test(accessToken)) fail('RESPONSE')
  if (!Number.isSafeInteger(expireIn) || expireIn < 1 || expireIn > 86400) fail('RESPONSE')
  return { accessToken, expireIn }
}

function createDingTalkAppTokenExchange(options) {
  let fetchImpl
  try {
    ;({ fetch: fetchImpl } = closedRecord(options, ['fetch']))
    if (typeof fetchImpl !== 'function') fail('INPUT')
  } catch {
    fail('INPUT')
  }

  return async function exchangeToken(credentials, options) {
    let appKey
    let appSecret
    let signal
    try {
      ;({ appKey, appSecret } = closedRecord(credentials, ['appKey', 'appSecret']))
      ;({ signal } = closedRecord(options, ['signal']))
      if (!validCredential(appKey) || !validCredential(appSecret)) fail('INPUT')
      isAborted(signal) // Native AbortSignal brand check; never read signal.reason.
    } catch {
      fail('INPUT')
    }
    checkAbort(signal)

    let response
    let reader
    let complete = false
    const abort = () => {
      if (reader) cancelReader(reader)
      else if (response) cancelBody(response)
    }
    EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
    try {
      // No Promise.race here: lifecycle owns prompt waiter cancellation and must
      // keep this underlying work charged until fetch/read actually settles.
      checkAbort(signal)
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret }),
        redirect: 'error',
        signal,
      })
      checkAbort(signal)
      let body
      try {
        body = validateResponse(response)
      } catch (error) {
        if (internalErrors.has(error)) throw error
        fail('RESPONSE')
      }
      reader = ReadableStream.prototype.getReader.call(body)
      const chunks = []
      let byteLength = 0
      let reads = 0
      while (true) {
        checkAbort(signal)
        // Empty chunks must not permit unbounded buffering or an infinite
        // immediately-resolved read loop that starves the lifecycle deadline.
        if (reads >= MAX_BODY_READS) fail('TOO_LARGE')
        reads += 1
        const { done, value } = await ReadableStreamDefaultReader.prototype.read.call(reader)
        checkAbort(signal)
        if (done) break
        if (isProxy(value) || !(value instanceof Uint8Array)) fail('RESPONSE')
        const chunkLength = typedArrayByteLength.call(value)
        byteLength += chunkLength
        if (byteLength > MAX_BODY_BYTES) fail('TOO_LARGE')
        // Copy before the next read so a source cannot mutate retained chunks.
        if (chunkLength > 0) {
          const chunk = new Uint8Array(chunkLength)
          Uint8Array.prototype.set.call(chunk, value)
          chunks.push(chunk)
        }
      }
      const result = parseBody(chunks, byteLength)
      checkAbort(signal)
      complete = true
      return result
    } catch (error) {
      // Recreate even our own errors: a dependency may have decorated one with
      // private fields. Never attach cause or inspect arbitrary error values.
      throw new YidaTokenExchangeError(isAborted(signal) ? 'ABORTED' : internalErrors.get(error) || 'UNAVAILABLE')
    } finally {
      EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      if (!complete) {
        if (reader) cancelReader(reader)
        else if (response) cancelBody(response)
      }
      if (reader) {
        try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader) } catch { /* Already released. */ }
      }
    }
  }
}

module.exports = { createDingTalkAppTokenExchange, YidaTokenExchangeError }
