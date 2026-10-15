'use strict'

// Internal, unregistered lifecycle only. Binding equality is not authorization;
// a future trusted loader must enforce its own active grant and durable generation.
const { createHmac, randomBytes } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { types: { isProxy } } = require('node:util')

const BINDING_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'credentialRef', 'credentialGeneration']
const CONFIG_KEYS = ['loadCredential', 'exchangeToken', 'monotonicNow', 'maxBindings',
  'maxOutstandingFlights', 'maxWaitersPerFlight', 'refreshTimeoutMs', 'safetySkewMs']
const CODES = new Set(['INVALID_INPUT', 'DISPOSED', 'NOT_ACTIVE', 'GENERATION_MISMATCH',
  'REVOKED', 'BINDING_LIMIT', 'FLIGHT_LIMIT', 'WAITER_LIMIT', 'CANCELLED', 'TIMEOUT',
  'CREDENTIAL_FAILED', 'CREDENTIAL_CHANGED', 'EXCHANGE_FAILED', 'INVALID_RESPONSE',
  'CLOCK_INVALID', 'EXPIRED'].map((code) => `YIDA_TOKEN_${code}`))
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener

class YidaTokenError extends Error {
  constructor(code) {
    const safeCode = CODES.has(code) ? code : 'YIDA_TOKEN_INVALID_INPUT'
    super(safeCode)
    this.name = 'YidaTokenError'
    this.code = safeCode
  }
}

function failure(code) { return new YidaTokenError(`YIDA_TOKEN_${code}`) }
function fail(code) { throw failure(code) }

// Inspect descriptors, never property values through accessors. Proxies that
// refuse reflection also produce a fixed error without retaining their exception.
function dataObject(value, keys, required = keys, code = 'INVALID_INPUT') {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) fail(code)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key])) fail(code)
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(descriptors, key)) fail(code)
    }
    const result = Object.create(null)
    for (const key of Object.keys(descriptors)) result[key] = descriptors[key].value
    return result
  } catch { fail(code) }
}

function opaque(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(code)
  return value
}

function bindingOf(value, code = 'INVALID_INPUT') {
  const data = dataObject(value, BINDING_KEYS, BINDING_KEYS, code)
  const generation = data.credentialGeneration
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647) fail(code)
  return Object.freeze({
    tenantId: opaque(data.tenantId, code),
    workspaceId: data.workspaceId === null ? null : opaque(data.workspaceId, code),
    ownerId: opaque(data.ownerId, code),
    credentialRef: opaque(data.credentialRef, code),
    credentialGeneration: generation,
  })
}

function keyOf(binding) {
  return JSON.stringify([binding.tenantId, binding.workspaceId, binding.ownerId, binding.credentialRef])
}

function boundedOption(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_INPUT')
  return value
}

function isAborted(signal) { return signal !== undefined && abortedGetter.call(signal) }

function callerSignal(options) {
  if (options === undefined) return undefined
  const { signal } = dataObject(options, ['signal'], [])
  if (signal !== undefined) {
    // Intrinsic getters also accept some inherited/proxied signal shapes in
    // Node. Their listeners do not provide the native cancellation contract.
    if (!signal || typeof signal !== 'object' || isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INVALID_INPUT')
    try { abortedGetter.call(signal) } catch { fail('INVALID_INPUT') }
  }
  return signal
}

function credentialMaterial(value, binding) {
  const data = dataObject(value, [...BINDING_KEYS, 'appKey', 'appSecret'],
    [...BINDING_KEYS, 'appKey', 'appSecret'], 'CREDENTIAL_FAILED')
  for (const key of BINDING_KEYS) {
    if (data[key] !== binding[key]) fail('CREDENTIAL_FAILED')
  }
  for (const key of ['appKey', 'appSecret']) {
    if (typeof data[key] !== 'string' || data[key].length > 4096 || data[key].trim().length === 0) {
      fail('CREDENTIAL_FAILED')
    }
  }
  // Spaces in otherwise valid credentials are intentional bytes, never trimmed.
  return Object.freeze({ appKey: data.appKey, appSecret: data.appSecret })
}

function tokenResult(value) {
  const data = dataObject(value, ['accessToken', 'expireIn'], ['accessToken', 'expireIn'], 'INVALID_RESPONSE')
  if (typeof data.accessToken !== 'string' || data.accessToken.length < 1 || data.accessToken.length > 8192
    || data.accessToken !== data.accessToken.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(data.accessToken)
    || !Number.isSafeInteger(data.expireIn) || data.expireIn < 1 || data.expireIn > 86400) {
    fail('INVALID_RESPONSE')
  }
  return data
}

function createYidaTokenClient(input) {
  const config = dataObject(input, CONFIG_KEYS, ['loadCredential', 'exchangeToken'])
  if (typeof config.loadCredential !== 'function' || typeof config.exchangeToken !== 'function'
    || (config.monotonicNow !== undefined && typeof config.monotonicNow !== 'function')) fail('INVALID_INPUT')
  const loadCredential = config.loadCredential
  const exchangeToken = config.exchangeToken
  const monotonicNow = config.monotonicNow ?? (() => performance.now())
  const maxBindings = boundedOption(config.maxBindings, 64, 1, 256)
  const maxOutstandingFlights = boundedOption(config.maxOutstandingFlights, 8, 1, 64)
  const maxWaitersPerFlight = boundedOption(config.maxWaitersPerFlight, 64, 1, 256)
  const refreshTimeoutMs = boundedOption(config.refreshTimeoutMs, 10000, 10, 60000)
  const safetySkewMs = boundedOption(config.safetySkewMs, 30000, 0, 120000)
  const materialKey = randomBytes(32)
  const entries = new Map()
  // Waiter cancellation is not dependency completion. Preserve the original
  // load/exchange/revalidation flight even after it is removed from entries.
  const actualFlights = new Set()
  let draining
  let disposed = false
  let outstanding = 0
  let lastNow = 0

  function now() {
    let value
    try { value = monotonicNow() } catch { value = NaN }
    if (!Number.isFinite(value) || value < lastNow || value < 0) {
      for (const entry of entries.values()) entry.cache = null
      fail('CLOCK_INVALID')
    }
    lastNow = value
    return value
  }

  function assertOpen() { if (disposed) fail('DISPOSED') }

  function currentEntry(binding) {
    assertOpen()
    const entry = entries.get(keyOf(binding))
    if (!entry) fail('NOT_ACTIVE')
    if (entry.binding.credentialGeneration !== binding.credentialGeneration) fail('GENERATION_MISMATCH')
    if (entry.revoked) fail('REVOKED')
    return entry
  }

  function assertCurrentFlight(flight) {
    if (flight.cancelled) throw flight.cancelled
    assertOpen()
    const entry = flight.entry
    if (entries.get(flight.key) !== entry || entry.flight !== flight) fail('GENERATION_MISMATCH')
    if (entry.revoked) fail('REVOKED')
    if (isAborted(flight.controller.signal)) fail('CANCELLED')
  }

  function checkFlight(flight) {
    assertCurrentFlight(flight)
    const checkedAt = now()
    // The injected clock is synchronous but may trigger local lifecycle work.
    assertCurrentFlight(flight)
    return checkedAt
  }

  function detachWaiter(flight, waiter) {
    flight.waiters.delete(waiter)
    if (waiter.signal !== undefined) removeListener.call(waiter.signal, 'abort', waiter.onAbort)
  }

  function rejectWaiters(flight, error) {
    for (const waiter of flight.waiters) {
      detachWaiter(flight, waiter)
      waiter.reject(error)
    }
  }

  function cancelFlight(flight, code) {
    if (!flight || flight.cancelled || flight.finished) return
    flight.cancelled = failure(code)
    clearTimeout(flight.timer)
    if (flight.entry.flight === flight) {
      flight.entry.flight = null
      flight.entry.cache = null
    }
    rejectWaiters(flight, flight.cancelled)
    flight.controller.abort()
    // No decrement here: a dependency can ignore abort and remain outstanding.
  }

  function activate(value) {
    assertOpen()
    const binding = bindingOf(value)
    const key = keyOf(binding)
    const previous = entries.get(key)
    if (previous) {
      if (binding.credentialGeneration < previous.binding.credentialGeneration) fail('GENERATION_MISMATCH')
      if (binding.credentialGeneration === previous.binding.credentialGeneration) {
        if (previous.revoked) fail('REVOKED')
        return
      }
      previous.cache = null
      previous.fingerprint = null
    } else if (entries.size >= maxBindings) fail('BINDING_LIMIT')
    // Abort listeners run synchronously and may activate a newer generation or
    // dispose this client. Publish first; never overwrite their later decision.
    entries.set(key, { binding, revoked: false, fingerprint: null, cache: null, flight: null })
    if (previous) cancelFlight(previous.flight, 'GENERATION_MISMATCH')
  }

  function revoke(value) {
    assertOpen()
    const binding = bindingOf(value)
    const entry = entries.get(keyOf(binding))
    if (!entry) fail('NOT_ACTIVE')
    if (entry.binding.credentialGeneration !== binding.credentialGeneration) fail('GENERATION_MISMATCH')
    entry.revoked = true
    entry.cache = null
    entry.fingerprint = null
    cancelFlight(entry.flight, 'REVOKED')
  }

  async function verifiedMaterial(flight) {
    let result
    try {
      result = await loadCredential(flight.entry.binding, Object.freeze({ signal: flight.controller.signal }))
    } catch { fail('CREDENTIAL_FAILED') }
    checkFlight(flight)
    const material = credentialMaterial(result, flight.entry.binding)
    const digest = createHmac('sha256', materialKey)
      .update(JSON.stringify([material.appKey, material.appSecret])).digest('hex')
    if (flight.entry.fingerprint !== null && flight.entry.fingerprint !== digest) fail('CREDENTIAL_CHANGED')
    flight.entry.fingerprint = digest
    return material
  }

  async function runFlight(flight) {
    checkFlight(flight)
    const material = await verifiedMaterial(flight)
    const checkedAt = checkFlight(flight)
    if (flight.entry.cache && flight.entry.cache.expiresAt > checkedAt) return flight.entry.cache
    flight.entry.cache = null
    // TTL includes time spent exchanging and revalidating credentials.
    const startedAt = checkFlight(flight)
    let response
    try {
      response = await exchangeToken(material, Object.freeze({ signal: flight.controller.signal }))
    } catch { fail('EXCHANGE_FAILED') }
    const receivedAt = checkFlight(flight)
    const parsed = tokenResult(response)
    const expiresAt = startedAt + parsed.expireIn * 1000 - safetySkewMs
    if (!Number.isFinite(expiresAt) || expiresAt <= receivedAt) fail('EXPIRED')
    await verifiedMaterial(flight)
    if (expiresAt <= checkFlight(flight)) fail('EXPIRED')
    const result = { token: parsed.accessToken, expiresAt }
    flight.entry.cache = result
    return result
  }

  function settleSuccess(flight, result) {
    for (const waiter of flight.waiters) {
      try {
        const checkedAt = checkFlight(flight)
        if (isAborted(waiter.signal)) fail('CANCELLED')
        if (result.expiresAt <= checkedAt) {
          flight.entry.cache = null
          fail('EXPIRED')
        }
        detachWaiter(flight, waiter)
        waiter.resolve(result.token)
      } catch (error) {
        detachWaiter(flight, waiter)
        waiter.reject(error)
      }
    }
  }

  function startFlight(entry) {
    const flight = { entry, key: keyOf(entry.binding), controller: new AbortController(),
      waiters: new Set(), cancelled: null, finished: false, timer: null }
    entry.flight = flight
    outstanding++
    flight.timer = setTimeout(() => cancelFlight(flight, 'TIMEOUT'), refreshTimeoutMs)
    const finish = () => {
      flight.finished = true
      clearTimeout(flight.timer)
      outstanding--
      if (entry.flight === flight) entry.flight = null
    }
    // Defer until the first waiter is registered; no dependency starts at creation.
    const pending = Promise.resolve().then(() => runFlight(flight)).then(
      (result) => {
        try { settleSuccess(flight, result) } finally { finish() }
      },
      (error) => {
        try {
          if (entry.flight === flight) entry.cache = null
          rejectWaiters(flight, flight.cancelled || error)
        } finally { finish() }
      },
    )
    actualFlights.add(pending)
    pending.then(() => actualFlights.delete(pending), () => actualFlights.delete(pending))
    return flight
  }

  function getAccessToken(value, options) {
    try {
      assertOpen()
      const binding = bindingOf(value)
      const signal = callerSignal(options)
      if (isAborted(signal)) fail('CANCELLED')
      const entry = currentEntry(binding)
      now()
      if (currentEntry(binding) !== entry) fail('GENERATION_MISMATCH')
      let flight = entry.flight
      if (flight && flight.waiters.size >= maxWaitersPerFlight) fail('WAITER_LIMIT')
      if (!flight) {
        if (outstanding >= maxOutstandingFlights) fail('FLIGHT_LIMIT')
        flight = startFlight(entry)
      }
      // Return this promise directly: the final publication check sits at the
      // exact waiter resolve point, without an extra async forwarding microtask.
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null }
        waiter.onAbort = () => {
          detachWaiter(flight, waiter)
          reject(failure('CANCELLED'))
          if (flight.waiters.size === 0) cancelFlight(flight, 'CANCELLED')
        }
        flight.waiters.add(waiter)
        if (signal !== undefined) {
          addListener.call(signal, 'abort', waiter.onAbort, { once: true })
          if (isAborted(signal)) waiter.onAbort()
        }
      })
    } catch (error) { return Promise.reject(error) }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const entry of entries.values()) {
      entry.cache = null
      entry.fingerprint = null
      cancelFlight(entry.flight, 'DISPOSED')
    }
    entries.clear()
    materialKey.fill(0)
    // JavaScript strings (including tokens already returned) cannot be wiped.
  }

  function disposeAndDrain() {
    // Latch and abort synchronously; the returned promise reflects the real
    // original flight, including response-body reads that ignore cancellation.
    dispose()
    if (!draining) draining = Promise.allSettled([...actualFlights]).then(() => undefined)
    return draining
  }

  return Object.freeze({ activate, revoke, getAccessToken, dispose, disposeAndDrain })
}

module.exports = { createYidaTokenClient, YidaTokenError }
