'use strict'

// Owner-run YiDa 测试连接, plugin side (ADR
// docs/development/takeover-beiliao-20260821/adr-yida-connection-test-20261028.md).
// Exactly one token exchange with the fixed DingTalk OAuth endpoint, through the
// sealed exchange module. The issued token is never bound to anything that
// outlives this call; the host receives only a closed { outcome } record. No
// form IO, no persistence, no send switch and no token client cache.

const { types: { isProxy } } = require('node:util')
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

function createConnectionProbe(options) {
  const { fetch } = closedRecord(options, ['fetch'])
  if (typeof fetch !== 'function' || isProxy(fetch)) fail('UNAVAILABLE')
  const exchange = createDingTalkAppTokenExchange({ fetch })
  return Object.freeze({
    async probe(credentials, callOptions) {
      const { appKey, appSecret } = closedRecord(credentials, ['appKey', 'appSecret'])
      const { signal } = closedRecord(callOptions, ['signal'])
      try {
        // The resolved { accessToken, expireIn } is deliberately not bound.
        await exchange({ appKey, appSecret }, { signal })
      } catch (error) {
        const code = exchangeCode(error)
        if (code === 'YIDA_TOKEN_EXCHANGE_ABORTED') fail('CANCELLED')
        if (code !== undefined && Object.hasOwn(OUTCOME_BY_EXCHANGE_CODE, code)) {
          return Object.freeze({ outcome: OUTCOME_BY_EXCHANGE_CODE[code] })
        }
        // INPUT (the host validates first) or anything foreign.
        fail('UNAVAILABLE')
      }
      return Object.freeze({ outcome: 'ok' })
    },
  })
}

/** Host-private binding for the connection-test runtime. Never published on communication. */
function createYidaConnectionProbeBinding() {
  return Object.freeze({ createConnectionProbe })
}

module.exports = { createYidaConnectionProbeBinding, YidaConnectionProbeError }
