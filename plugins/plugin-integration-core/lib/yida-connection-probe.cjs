'use strict'

// Owner-run YiDa 测试连接, plugin side (ADR
// docs/development/takeover-beiliao-20260821/adr-yida-connection-test-20261028.md).
// Exactly one token exchange with the fixed DingTalk OAuth endpoint, through the
// sealed exchange module. The issued token is never bound to anything that
// outlives this call; the host receives only a closed { outcome } record. No
// form write, no persistence, no send switch and no token client cache.
// probeForm() (ADR addendum 2026-11-23, its own default-OFF host switch) uses that one
// token for exactly one READ of the form's component definitions, then drops it; the
// host receives { outcome, form } with field IDs, labels and component names only.

const { types: { isProxy } } = require('node:util')
const { ReadableStream, ReadableStreamDefaultReader } = require('node:stream/web')
const { createDingTalkAppTokenExchange, YidaTokenExchangeError } = require('./yida-token-exchange.cjs')

const OUTCOME_BY_EXCHANGE_CODE = Object.freeze({
  // The exchange discards the HTTP status: wrong credentials, throttling, 5xx,
  // a proxy page and schema drift are all one class. Never refined here.
  YIDA_TOKEN_EXCHANGE_RESPONSE: 'upstream_rejected',
  YIDA_TOKEN_EXCHANGE_TOO_LARGE: 'upstream_rejected',
  // DNS / TLS / connect / redirect failures.
  YIDA_TOKEN_EXCHANGE_UNAVAILABLE: 'unreachable',
})

class YidaConnectionProbeError extends Error {
  constructor(kind) {
    const fixed = kind === 'CANCELLED' ? 'CANCELLED' : 'UNAVAILABLE'
    super(`YIDA_CONNECTION_PROBE_${fixed}`)
    this.name = 'YidaConnectionProbeError'
    this.code = this.message
  }
}

function fail(kind) {
  throw new YidaConnectionProbeError(kind)
}

function closedRecord(value, keys) {
  if (!value || typeof value !== 'object' || isProxy(value)) fail('UNAVAILABLE')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('UNAVAILABLE')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail('UNAVAILABLE')
  const result = Object.create(null)
  for (const key of keys) {
    if (!Object.hasOwn(descriptors[key], 'value')) fail('UNAVAILABLE')
    result[key] = descriptors[key].value
  }
  return result
}

// Only errors this process's own exchange module constructed are classified; the
// exchange rebuilds every error it throws (no cause, no body).
function exchangeCode(error) {
  if (!error || typeof error !== 'object' || isProxy(error)
    || Object.getPrototypeOf(error) !== YidaTokenExchangeError.prototype) return undefined
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  return code && Object.hasOwn(code, 'value') && typeof code.value === 'string' ? code.value : undefined
}

// ── probeForm(): the same single exchange, then ONE read of the form's component definitions ──────
// Official DingTalk API 「获取表单组件定义列表」 (permission 宜搭表单数据读权限). A fixed host and path
// prefix: appType and formUuid are path segments, so both must match the closed identifier shape below.
// The access token lives only in this call frame; the host receives { outcome, form } and nothing else.
const DEFINITIONS_ENDPOINT = 'https://api.dingtalk.com/v1.0/yida/forms/definitions/'
const FORM_MAX_BYTES = 256 * 1024
const FORM_MAX_READS = FORM_MAX_BYTES + 1
const FORM_MAX_FIELDS = 256
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/
const FIELD_ID = /^[A-Za-z0-9_-]{1,128}$/
const COMPONENT = /^[A-Za-z][A-Za-z0-9]{0,63}$/
// eslint-disable-next-line no-control-regex -- refuse control characters in the private query values and labels.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get
const responseRedirected = Object.getOwnPropertyDescriptor(Response.prototype, 'redirected').get
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, 'headers').get
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get
// RESPONSE: non-2xx, redirect, malformed or unexpected body (a wrong systemToken/userId/appType/formUuid,
// a missing permission, throttling and schema drift all look alike here). UNAVAILABLE: no answer at all.
const FORM_OUTCOME_BY_READ = Object.freeze({ RESPONSE: 'upstream_rejected', TOO_LARGE: 'upstream_rejected', UNAVAILABLE: 'unreachable' })
const readErrors = new WeakMap()
function readFail(kind) {
  const error = new Error('YiDa form definition read failed')
  readErrors.set(error, kind)
  throw error
}

function formTarget(value) {
  const row = closedRecord(value, ['appType', 'formUuid', 'systemToken', 'userId'])
  if (typeof row.appType !== 'string' || !PATH_ID.test(row.appType)
    || typeof row.formUuid !== 'string' || !PATH_ID.test(row.formUuid)) fail('UNAVAILABLE')
  for (const key of ['systemToken', 'userId']) {
    const text = row[key]
    if (typeof text !== 'string' || !text || text.length > (key === 'userId' ? 128 : 4096) || text.trim() !== text
      || CONTROL.test(text) || /[\p{Cf}\p{Cs}]/u.test(text)) fail('UNAVAILABLE')
  }
  return row
}
function definitionsUrl(target) {
  const url = new URL(`${DEFINITIONS_ENDPOINT}${target.appType}/${target.formUuid}`)
  url.search = new URLSearchParams({ systemToken: target.systemToken, userId: target.userId, language: 'zh_CN' }).toString()
  return url.href
}
function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function labelOf(value) {
  // A plain string, or an i18n object whose zh_CN (else en_US) is a string. Anything else is blank:
  // the page then shows the field ID. A label is display text only and never decides anything.
  const text = typeof value === 'string' ? value
    : plainObject(value) && typeof value.zh_CN === 'string' ? value.zh_CN
      : plainObject(value) && typeof value.en_US === 'string' ? value.en_US : ''
  const trimmed = text.trim()
  return trimmed.length <= 256 && !CONTROL.test(trimmed) ? trimmed : ''
}
function definitionFields(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { readFail('RESPONSE') }
  if (!plainObject(parsed) || !Array.isArray(parsed.result)) readFail('RESPONSE')
  if (parsed.result.length > FORM_MAX_FIELDS) readFail('TOO_LARGE')
  const seen = new Set()
  const fields = parsed.result.map((item) => {
    if (!plainObject(item) || typeof item.fieldId !== 'string' || !FIELD_ID.test(item.fieldId)
      || typeof item.componentName !== 'string' || !COMPONENT.test(item.componentName) || seen.has(item.fieldId)) readFail('RESPONSE')
    seen.add(item.fieldId)
    const parentId = typeof item.parentId === 'string' && FIELD_ID.test(item.parentId) ? item.parentId : null
    return Object.freeze({ fieldId: item.fieldId, label: labelOf(item.label), componentName: item.componentName, parentId })
  })
  return Object.freeze(fields)
}
function releaseBody(response, reader) {
  try {
    if (reader) Promise.resolve(ReadableStreamDefaultReader.prototype.cancel.call(reader)).catch(() => {})
    else if (response && typeof response === 'object' && !isProxy(response) && Object.getPrototypeOf(response) === Response.prototype) {
      const body = responseBody.call(response)
      if (body) Promise.resolve(ReadableStream.prototype.cancel.call(body)).catch(() => {})
    }
  } catch { /* Best effort only, not a physical socket termination guarantee. */ }
}
async function readDefinitions(fetch, target, accessToken, signal) {
  let response
  let reader
  let complete = false
  try {
    if (signalAborted.call(signal)) readFail('ABORTED')
    try {
      response = await fetch(definitionsUrl(target), { method: 'GET',
        headers: { Accept: 'application/json', 'x-acs-dingtalk-access-token': accessToken }, redirect: 'error', signal })
    } catch { readFail(signalAborted.call(signal) ? 'ABORTED' : 'UNAVAILABLE') }
    if (signalAborted.call(signal)) readFail('ABORTED')
    if (!response || typeof response !== 'object' || isProxy(response) || Object.getPrototypeOf(response) !== Response.prototype) readFail('RESPONSE')
    const statusCode = responseStatus.call(response)
    if (responseRedirected.call(response) || statusCode < 200 || statusCode > 299) readFail('RESPONSE')
    const declared = Headers.prototype.get.call(responseHeaders.call(response), 'content-length')
    if (declared !== null) {
      if (!/^[0-9]+$/.test(declared)) readFail('RESPONSE')
      if (Number(declared) > FORM_MAX_BYTES) readFail('TOO_LARGE')
    }
    const body = responseBody.call(response)
    if (body === null) readFail('RESPONSE')
    reader = ReadableStream.prototype.getReader.call(body)
    const chunks = []
    let byteLength = 0
    for (let reads = 0; ; reads += 1) {
      if (reads >= FORM_MAX_READS) readFail('TOO_LARGE')
      let step
      try { step = await ReadableStreamDefaultReader.prototype.read.call(reader) } catch { readFail(signalAborted.call(signal) ? 'ABORTED' : 'UNAVAILABLE') }
      if (signalAborted.call(signal)) readFail('ABORTED')
      if (step.done) break
      if (isProxy(step.value) || !(step.value instanceof Uint8Array)) readFail('RESPONSE')
      const length = typedArrayByteLength.call(step.value)
      byteLength += length
      if (byteLength > FORM_MAX_BYTES) readFail('TOO_LARGE')
      if (length > 0) {
        const chunk = new Uint8Array(length)
        Uint8Array.prototype.set.call(chunk, step.value)
        chunks.push(chunk)
      }
    }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { readFail('RESPONSE') }
    const fields = definitionFields(text)
    complete = true
    return fields
  } catch (error) {
    if (readErrors.has(error)) throw error
    readFail('UNAVAILABLE')
  } finally {
    if (!complete) releaseBody(response, reader)
    if (reader) { try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader) } catch { /* Already released. */ } }
  }
}

function createConnectionProbe(options) {
  const { fetch } = closedRecord(options, ['fetch'])
  if (typeof fetch !== 'function' || isProxy(fetch)) fail('UNAVAILABLE')
  const exchange = createDingTalkAppTokenExchange({ fetch })
  // Exactly one exchange. probe() drops the token at once; probeForm() spends it on one read.
  async function exchangeOnce(credentials, signal) {
    const { appKey, appSecret } = closedRecord(credentials, ['appKey', 'appSecret'])
    try {
      const issued = await exchange({ appKey, appSecret }, { signal })
      return { outcome: 'ok', accessToken: issued.accessToken }
    } catch (error) {
      const code = exchangeCode(error)
      if (code === 'YIDA_TOKEN_EXCHANGE_ABORTED') fail('CANCELLED')
      if (code !== undefined && Object.hasOwn(OUTCOME_BY_EXCHANGE_CODE, code)) return { outcome: OUTCOME_BY_EXCHANGE_CODE[code] }
      // INPUT (the host validates first) or anything foreign.
      fail('UNAVAILABLE')
    }
  }
  return Object.freeze({
    async probe(credentials, callOptions) {
      const { signal } = closedRecord(callOptions, ['signal'])
      // The issued token is deliberately not kept.
      const { outcome } = await exchangeOnce(credentials, signal)
      return Object.freeze({ outcome })
    },
    async probeForm(credentials, form, callOptions) {
      const target = formTarget(form)
      const { signal } = closedRecord(callOptions, ['signal'])
      const exchanged = await exchangeOnce(credentials, signal)
      if (exchanged.outcome !== 'ok') return Object.freeze({ outcome: exchanged.outcome, form: Object.freeze({ outcome: 'not_attempted' }) })
      let accessToken = exchanged.accessToken
      exchanged.accessToken = undefined
      try {
        const fields = await readDefinitions(fetch, target, accessToken, signal)
        return Object.freeze({ outcome: 'ok', form: Object.freeze({ outcome: 'ok', fields }) })
      } catch (error) {
        const kind = readErrors.get(error)
        // The deadline (or the caller) aborted the read: the pair was fine, the form answer is unknown.
        // A caller cancel is still reported as CANCELLED by the host's own checkpoint.
        if (kind === 'ABORTED') return Object.freeze({ outcome: 'ok', form: Object.freeze({ outcome: 'timeout' }) })
        if (kind !== undefined && Object.hasOwn(FORM_OUTCOME_BY_READ, kind)) {
          return Object.freeze({ outcome: 'ok', form: Object.freeze({ outcome: FORM_OUTCOME_BY_READ[kind] }) })
        }
        fail('UNAVAILABLE')
      } finally { accessToken = undefined }
    },
  })
}

/** Host-private binding for the connection-test runtime. Never published on communication. */
function createYidaConnectionProbeBinding() {
  return Object.freeze({ createConnectionProbe })
}

module.exports = { createYidaConnectionProbeBinding, YidaConnectionProbeError }
