'use strict'

const { ReadableStream, ReadableStreamDefaultReader } = require('node:stream/web')
const { types: { isProxy, isPromise } } = require('node:util')

const ENDPOINT = 'https://api.dingtalk.com/v1.0/yida/forms/instances/'
const MAX_BYTES = 128 * 1024
const MAX_READS = MAX_BYTES + 1
const MAX_DEPTH = 12
const MAX_NODES = 4096
const MAX_ITEMS = 256
const MAX_STRING = 8192
// eslint-disable-next-line no-control-regex -- Explicitly reject control characters in bounded public identifiers and the access header.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const TOP_FIELDS = ['formInstId', 'formData', 'modifiedTimeGMT', 'originator']
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get
const responseRedirected = Object.getOwnPropertyDescriptor(Response.prototype, 'redirected').get
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, 'headers').get
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get
const ownErrors = new WeakMap()
const MESSAGES = Object.freeze({
  INPUT: 'Invalid form readback input',
  DISABLED: 'Form readback disabled',
  ABORTED: 'Form readback cancelled',
  RESPONSE: 'Invalid form readback response',
  TOO_LARGE: 'Form readback exceeds limit',
  UNAVAILABLE: 'Form readback unavailable',
})

class YidaFormReadbackError extends Error {
  constructor(kind = 'UNAVAILABLE') {
    const safeKind = typeof kind === 'string' && Object.hasOwn(MESSAGES, kind) ? kind : 'UNAVAILABLE'
    super(MESSAGES[safeKind])
    this.name = 'YidaFormReadbackError'
    this.code = `YIDA_READBACK_${safeKind}`
    ownErrors.set(this, safeKind)
  }
}

function fail(kind) { throw new YidaFormReadbackError(kind) }

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

function boundedId(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !CONTROL.test(value)
}

function privateText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim().length > 0
}

// URLSearchParams replaces lone surrogates. Refuse them before serialization;
// valid Unicode pairs, whitespace and every other credential byte stay intact.
function wellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function aborted(signal) {
  if (!signal || typeof signal !== 'object' || isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  return signalAborted.call(signal)
}

function checkAbort(signal) { if (aborted(signal)) fail('ABORTED') }

function requestInput(input) {
  const request = record(input, ['appType', 'instanceId', 'accessToken', 'systemToken', 'userId'])
  if (!boundedId(request.appType, 128) || typeof request.instanceId !== 'string' || !INSTANCE_ID.test(request.instanceId)
    || !boundedId(request.accessToken, 8192) || !privateText(request.systemToken, 4096)
    || !privateText(request.userId, 128)) fail('INPUT')
  if (![request.appType, request.systemToken, request.userId].every(wellFormedUnicode)) fail('INPUT')
  const url = new URL(ENDPOINT + request.instanceId)
  url.search = new URLSearchParams({ appType: request.appType, systemToken: request.systemToken, userId: request.userId }).toString()
  return { url: url.href, instanceId: request.instanceId, accessToken: request.accessToken }
}

function cancelBody(response) {
  try {
    if (isProxy(response)) return
    const body = responseBody.call(response)
    if (body) Promise.resolve(ReadableStream.prototype.cancel.call(body)).catch(() => {})
  } catch { /* Best effort only, not a physical socket termination guarantee. */ }
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
    if (!Number.isSafeInteger(length) || length > MAX_BYTES) fail('TOO_LARGE')
  }
  const body = responseBody.call(response)
  if (body === null) fail('RESPONSE')
  return { statusCode, body }
}

const digit = (character) => character >= '0' && character <= '9'
const whitespace = (character) => character === ' ' || character === '\t' || character === '\r' || character === '\n'
const hex = (character) => digit(character) || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')

// Normalize decimal spelling without expanding an exponent or using a BigInt.
// Inputs have already passed the number grammar. Saturation bounds exponent
// work even for hostile long exponent spellings; zero needs no exponent at all.
function decimalIdentity(token) {
  let offset = token[0] === '-' ? 1 : 0
  const negative = offset === 1
  const integerStart = offset
  while (digit(token[offset])) offset += 1
  const integerEnd = offset
  let fractionStart = offset
  let fractionEnd = offset
  if (token[offset] === '.') {
    fractionStart = ++offset
    while (digit(token[offset])) offset += 1
    fractionEnd = offset
  }
  const coefficient = token.slice(integerStart, integerEnd) + token.slice(fractionStart, fractionEnd)
  let first = 0
  while (first < coefficient.length && coefficient[first] === '0') first += 1
  if (first === coefficient.length) return '0'
  let last = coefficient.length - 1
  while (coefficient[last] === '0') last -= 1
  let exponent = 0
  if (token[offset] === 'e' || token[offset] === 'E') {
    offset += 1
    const exponentNegative = token[offset] === '-'
    if (token[offset] === '+' || token[offset] === '-') offset += 1
    while (offset < token.length) {
      exponent = exponent * 10 + token.charCodeAt(offset++) - 48
      if (exponent > MAX_BYTES + 400) fail('RESPONSE')
    }
    if (exponentNegative) exponent = -exponent
  }
  exponent += coefficient.length - 1 - last - (fractionEnd - fractionStart)
  return `${negative ? '-' : ''}${coefficient.slice(first, last + 1)}e${exponent}`
}

// Bounded recursive-descent parsing: duplicate keys and numeric lexemes are
// checked BEFORE accepting values. JSON.parse is used only for one validated,
// bounded string literal, never to round a document's numbers first.
function parseLosslessJson(text) {
  let offset = 0
  let nodes = 0
  function skipWhitespace() { while (whitespace(text[offset])) offset += 1 }
  function quoted() {
    if (text[offset] !== '"') fail('RESPONSE')
    const start = offset++
    let length = 0
    while (offset < text.length) {
      const character = text[offset++]
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)) } catch { fail('RESPONSE') }
      }
      if (character.charCodeAt(0) < 0x20) fail('RESPONSE')
      if (character === '\\') {
        const escaped = text[offset++]
        if (escaped === 'u') {
          for (let count = 0; count < 4; count += 1) if (!hex(text[offset++])) fail('RESPONSE')
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) fail('RESPONSE')
      }
      if (++length > MAX_STRING) fail('TOO_LARGE')
    }
    fail('RESPONSE')
  }
  function number() {
    const start = offset
    if (text[offset] === '-') offset += 1
    if (text[offset] === '0') offset += 1
    else {
      if (!(text[offset] >= '1' && text[offset] <= '9')) fail('RESPONSE')
      while (digit(text[offset])) offset += 1
    }
    if (text[offset] === '.') {
      offset += 1
      if (!digit(text[offset])) fail('RESPONSE')
      while (digit(text[offset])) offset += 1
    }
    if (text[offset] === 'e' || text[offset] === 'E') {
      offset += 1
      if (text[offset] === '+' || text[offset] === '-') offset += 1
      if (!digit(text[offset])) fail('RESPONSE')
      while (digit(text[offset])) offset += 1
    }
    const token = text.slice(start, offset)
    const value = Number(token)
    if (!Number.isFinite(value) || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('RESPONSE')
    if (decimalIdentity(token) !== decimalIdentity(String(value))) fail('RESPONSE')
    return value
  }
  function value(depth) {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail('TOO_LARGE')
    skipWhitespace()
    const character = text[offset]
    if (character === '"') return quoted()
    if (character === '-' || digit(character)) return number()
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result }
    }
    if (character === '[') {
      offset += 1
      skipWhitespace()
      const result = []
      if (text[offset] !== ']') {
        // eslint-disable-next-line no-constant-condition -- Every iteration consumes one value and is capped by MAX_ITEMS and the global parser budgets.
        while (true) {
          if (result.length >= MAX_ITEMS) fail('TOO_LARGE')
          result.push(value(depth + 1))
          skipWhitespace()
          if (text[offset] === ']') break
          if (text[offset++] !== ',') fail('RESPONSE')
          skipWhitespace()
        }
      }
      offset += 1
      return Object.freeze(result)
    }
    if (character === '{') {
      offset += 1
      skipWhitespace()
      const result = {}
      const keys = new Set()
      if (text[offset] !== '}') {
        // eslint-disable-next-line no-constant-condition -- Every iteration consumes a unique key/value pair and is capped by MAX_ITEMS and the global parser budgets.
        while (true) {
          if (keys.size >= MAX_ITEMS) fail('TOO_LARGE')
          const key = quoted()
          if (keys.has(key)) fail('RESPONSE')
          keys.add(key)
          skipWhitespace()
          if (text[offset++] !== ':') fail('RESPONSE')
          const entry = value(depth + 1)
          Object.defineProperty(result, key, { value: entry, enumerable: true })
          skipWhitespace()
          if (text[offset] === '}') break
          if (text[offset++] !== ',') fail('RESPONSE')
          skipWhitespace()
        }
      }
      offset += 1
      return Object.freeze(result)
    }
    fail('RESPONSE')
  }
  const result = value(0)
  skipWhitespace()
  if (offset !== text.length) fail('RESPONSE')
  return result
}

function decode(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { fail('RESPONSE') }
}

function createYidaFormReadback(options) {
  let fetchImpl
  let readEnablement
  try {
    const settings = record(options, ['fetch'], ['readEnablement'])
    fetchImpl = settings.fetch
    readEnablement = Object.hasOwn(settings, 'readEnablement') ? settings.readEnablement : () => undefined
    if (typeof fetchImpl !== 'function' || typeof readEnablement !== 'function') fail('INPUT')
  } catch { fail('INPUT') }

  async function read(input, options) {
    let request
    let signal
    try {
      request = requestInput(input)
      ;({ signal } = record(options, ['signal']))
      aborted(signal)
    } catch { fail('INPUT') }
    checkAbort(signal)
    let enablement
    try { enablement = readEnablement() } catch { fail('DISABLED') }
    if (enablement !== 'true') {
      // Observe accidental ordinary rejected Promises without evaluating a
      // caller's constructor/species. Hostile pre-rejected dependency objects
      // and globally patched Promise intrinsics are not an unhandled-rejection
      // containment boundary; asynchronous enablement is always refused.
      try {
        if (isPromise(enablement) && !isProxy(enablement)
          && Object.getPrototypeOf(enablement) === Promise.prototype
          && !Object.hasOwn(enablement, 'constructor')) {
          Promise.prototype.then.call(enablement, undefined, () => {})
        }
      } catch { /* Observation must never replace the closed disabled error. */ }
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
      const pending = fetchImpl(request.url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'x-acs-dingtalk-access-token': request.accessToken },
        redirect: 'error', signal,
      })
      if (isProxy(pending)) fail('RESPONSE')
      // No race-abandonment or retry: an ignored cancellation keeps this actual
      // fetch/read pending until settlement, then discards the late observation.
      response = isPromise(pending) ? await pending : pending
      checkAbort(signal)
      let inspected
      try { inspected = inspectResponse(response) } catch (error) {
        if (ownErrors.has(error)) throw error
        fail('RESPONSE')
      }
      reader = ReadableStream.prototype.getReader.call(inspected.body)
      const chunks = []
      let byteLength = 0
      let reads = 0
      // eslint-disable-next-line no-constant-condition -- MAX_READS bounds all attempts, including empty chunks; EOF exits and MAX_BYTES bounds buffered data.
      while (true) {
        checkAbort(signal)
        if (reads >= MAX_READS) fail('TOO_LARGE')
        reads += 1
        const { done, value } = await ReadableStreamDefaultReader.prototype.read.call(reader)
        checkAbort(signal)
        if (done) break
        if (isProxy(value) || !(value instanceof Uint8Array)) fail('RESPONSE')
        const chunkLength = typedArrayByteLength.call(value)
        byteLength += chunkLength
        if (byteLength > MAX_BYTES) fail('TOO_LARGE')
        if (chunkLength > 0) {
          const chunk = new Uint8Array(chunkLength)
          Uint8Array.prototype.set.call(chunk, value)
          chunks.push(chunk)
        }
      }
      const parsed = parseLosslessJson(decode(chunks, byteLength))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).some((key) => !TOP_FIELDS.includes(key))
        || !Object.hasOwn(parsed, 'formInstId') || parsed.formInstId !== request.instanceId
        || !Object.hasOwn(parsed, 'formData') || !parsed.formData || typeof parsed.formData !== 'object'
        || Array.isArray(parsed.formData)) fail('RESPONSE')
      checkAbort(signal)
      complete = true
      // Request appType is NOT echoed by the official response. This observation
      // proves neither form ownership, historical writes nor business success.
      return Object.freeze({ statusCode: inspected.statusCode, instanceId: parsed.formInstId, formData: parsed.formData })
    } catch (error) {
      throw new YidaFormReadbackError(aborted(signal) ? 'ABORTED' : ownErrors.get(error) || 'UNAVAILABLE')
    } finally {
      EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      if (!complete) { if (reader) cancelReader(reader); else if (response) cancelBody(response) }
      if (reader) { try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader) } catch { /* Already released. */ } }
    }
  }
  return Object.freeze({ read })
}

module.exports = { createYidaFormReadback, YidaFormReadbackError }
