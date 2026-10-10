'use strict'

// SA05A1: actual private lifecycle, synthetic provider/exchange only. No env,
// database or network. These supplied scopes do not prove runtime authorization.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createYidaTokenClient, YidaTokenError } = require('../lib/yida-token-client.cjs')

const binding = (patch = {}) => ({
  tenantId: 'synthetic-tenant-a', workspaceId: null, ownerId: 'synthetic-owner-a',
  credentialRef: 'synthetic-credential-a', credentialGeneration: 1, ...patch,
})
const credential = (scope, patch = {}) => ({
  ...scope, appKey: 'synthetic-private-app-key', appSecret: 'synthetic-private-app-secret', ...patch,
})
const response = (patch = {}) => ({ accessToken: 'synthetic-private-token', expireIn: 60, ...patch })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const observe = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }

function fixedError(error, code) {
  assert.ok(error instanceof YidaTokenError)
  assert.equal(error.code, `YIDA_TOKEN_${code}`)
  assert.equal(error.message, error.code)
  assert.equal(error.cause, undefined)
  assert.equal(error.response, undefined)
  assert.equal(error.body, undefined)
  assert.ok(Object.keys(error).every((key) => ['name', 'code'].includes(key)))
  assert.ok(!JSON.stringify(error).includes('synthetic-private'))
  return true
}

async function rejected(action, code) {
  await assert.rejects(action, (error) => fixedError(error, code))
}

async function failed(result, code) {
  const outcome = await result
  assert.ok(Object.hasOwn(outcome, 'error'), 'expected a rejected token waiter')
  fixedError(outcome.error, code)
}

async function timely(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic waiter did not settle promptly')), 500) }),
    ])
  } finally { clearTimeout(timer) }
}

function harness(t, options = {}) {
  const h = {
    now: 0, loads: [], exchanges: [],
    provider: async (scope) => credential(scope),
    exchange: async () => response(),
  }
  h.client = createYidaTokenClient({
    loadCredential: async (scope, context) => {
      assert.ok(context.signal instanceof AbortSignal)
      h.loads.push({ scope, signal: context.signal })
      return h.provider(scope, context)
    },
    exchangeToken: async (material, context) => {
      assert.ok(context.signal instanceof AbortSignal)
      h.exchanges.push({ material, signal: context.signal })
      return h.exchange(material, context)
    },
    monotonicNow: () => h.now,
    safetySkewMs: 0,
    refreshTimeoutMs: 1000,
    ...options,
  })
  t.after(() => h.client.dispose())
  return h
}

test('activation is explicit; generation is monotonic and revoked generations cannot be regranted', async (t) => {
  const h = harness(t)
  const one = binding()
  const two = binding({ credentialGeneration: 2 })
  await rejected(h.client.getAccessToken(one), 'NOT_ACTIVE')
  assert.equal(h.loads.length, 0)
  h.client.activate(one)
  h.client.activate(one)
  assert.equal(await h.client.getAccessToken(one), response().accessToken)
  h.client.activate(two)
  assert.throws(() => h.client.activate(one), (error) => fixedError(error, 'GENERATION_MISMATCH'))
  assert.throws(() => h.client.revoke(one), (error) => fixedError(error, 'GENERATION_MISMATCH'))
  await rejected(h.client.getAccessToken(one), 'GENERATION_MISMATCH')
  assert.equal(await h.client.getAccessToken(two), response().accessToken)
  h.client.revoke(two)
  await rejected(h.client.getAccessToken(two), 'REVOKED')
  assert.throws(() => h.client.activate(two), (error) => fixedError(error, 'REVOKED'))
  const three = binding({ credentialGeneration: 3 })
  h.client.activate(three)
  assert.equal(await h.client.getAccessToken(three), response().accessToken)
})

test('tenant, explicit workspace, owner and credential reference have separate token identities', async (t) => {
  const h = harness(t)
  const scopes = [binding(), ...[
    { tenantId: 'synthetic-tenant-b' }, { workspaceId: 'synthetic-workspace-b' },
    { ownerId: 'synthetic-owner-b' }, { credentialRef: 'synthetic-credential-b' },
    { tenantId: 'a:b', ownerId: 'c' }, { tenantId: 'a', ownerId: 'b:c' },
  ].map(binding)]
  h.exchange = async () => response({ accessToken: `synthetic-private-token-${h.exchanges.length}` })
  const tokens = []
  for (const scope of scopes) {
    h.client.activate(scope)
    tokens.push(await h.client.getAccessToken(scope))
  }
  assert.equal(new Set(tokens).size, scopes.length)
  for (let index = 0; index < scopes.length; index += 1) {
    assert.equal(await h.client.getAccessToken(scopes[index]), tokens[index])
  }
  assert.equal(h.exchanges.length, scopes.length)
  h.client.revoke(scopes[0])
  assert.equal(await h.client.getAccessToken(scopes[1]), tokens[1])
})

test('each cache hit revalidates the provider and rejects provider denial without serving cached token', async (t) => {
  const h = harness(t)
  h.client.activate(binding())
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  assert.equal(h.loads.length, 2, 'a refreshed token requires both provider validations')
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  assert.equal(h.loads.length, 3)
  assert.equal(h.exchanges.length, 1)
  h.provider = async () => { throw new Error('synthetic-private-provider-denial') }
  await rejected(h.client.getAccessToken(binding()), 'CREDENTIAL_FAILED')
  h.provider = async (scope) => credential(scope)
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  assert.equal(h.exchanges.length, 2, 'provider denial must have cleared the old cache')
})

test('same-scope same-generation callers share the complete load/exchange/revalidation flight', async (t) => {
  const h = harness(t)
  const gate = deferred()
  h.provider = async (scope) => { if (h.loads.length === 1) await gate.promise; return credential(scope) }
  h.client.activate(binding())
  const a = h.client.getAccessToken(binding())
  const b = h.client.getAccessToken(binding())
  await flush()
  assert.equal(h.loads.length, 1)
  assert.equal(h.exchanges.length, 0)
  gate.resolve()
  assert.deepEqual(await Promise.all([a, b]), [response().accessToken, response().accessToken])
  assert.equal(h.loads.length, 2)
  assert.equal(h.exchanges.length, 1)
  assert.deepEqual(h.exchanges[0].material, { appKey: credential(binding()).appKey, appSecret: credential(binding()).appSecret })
  assert.ok(Object.isFrozen(h.loads[0].scope))
})

test('a cache hit cannot cross a generation rotation during provider validation', async (t) => {
  const h = harness(t)
  h.client.activate(binding())
  await h.client.getAccessToken(binding())
  const gate = deferred()
  h.provider = async (scope) => { await gate.promise; return credential(scope) }
  const old = observe(h.client.getAccessToken(binding()))
  await flush()
  h.client.activate(binding({ credentialGeneration: 2 }))
  await timely(failed(old, 'GENERATION_MISMATCH'))
  gate.resolve()
  await flush()
  assert.equal(h.exchanges.length, 1)
})

test('same-generation material changes clear the cache and cannot silently replace credentials', async (t) => {
  for (const field of ['appKey', 'appSecret']) {
    const h = harness(t)
    h.client.activate(binding())
    await h.client.getAccessToken(binding())
    h.provider = async (scope) => credential(scope, { [field]: 'synthetic-private-changed' })
    await rejected(h.client.getAccessToken(binding()), 'CREDENTIAL_CHANGED')
    assert.equal(h.exchanges.length, 1)
    h.provider = async (scope) => credential(scope)
    assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
    assert.equal(h.exchanges.length, 2, 'material drift must remove the previous token')
  }
})

test('post-exchange provider rejection or material drift cannot publish a token', async (t) => {
  for (const mode of ['denied', 'changed']) {
    const h = harness(t)
    h.client.activate(binding())
    h.provider = async (scope) => {
      if (h.loads.length === 2) {
        if (mode === 'denied') throw new Error('synthetic-private-post-exchange-denial')
        return credential(scope, { appSecret: 'synthetic-private-changed' })
      }
      return credential(scope)
    }
    await rejected(h.client.getAccessToken(binding()), mode === 'denied' ? 'CREDENTIAL_FAILED' : 'CREDENTIAL_CHANGED')
    assert.equal(h.exchanges.length, 1)
    h.provider = async (scope) => credential(scope)
    assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
    assert.equal(h.exchanges.length, 2)
  }
})

for (const boundary of ['initial-load', 'exchange', 'post-load']) {
  for (const transition of ['rotate', 'revoke', 'dispose']) {
    test(`${transition} fences a late ${boundary} result and settles waiters before the dependency ends`, async (t) => {
      const h = harness(t)
      const gate = deferred()
      const reached = deferred()
      h.client.activate(binding())
      h.provider = async (scope) => {
        if ((boundary === 'initial-load' && h.loads.length === 1) || (boundary === 'post-load' && h.loads.length === 2)) {
          reached.resolve()
          await gate.promise
        }
        return credential(scope)
      }
      h.exchange = async () => {
        if (boundary === 'exchange') { reached.resolve(); await gate.promise }
        return response()
      }
      const pending = observe(h.client.getAccessToken(binding()))
      await timely(reached.promise)
      if (transition === 'rotate') h.client.activate(binding({ credentialGeneration: 2 }))
      else if (transition === 'revoke') h.client.revoke(binding())
      else h.client.dispose()
      const expected = { rotate: 'GENERATION_MISMATCH', revoke: 'REVOKED', dispose: 'DISPOSED' }[transition]
      await timely(failed(pending, expected))
      assert.equal(h.loads[0].signal.aborted, true)
      gate.resolve()
      await flush()
      if (boundary === 'initial-load') assert.equal(h.exchanges.length, 0, 'late loader must never start an exchange')
      else assert.equal(h.exchanges.length, 1)
      if (transition === 'rotate') {
        assert.equal(await h.client.getAccessToken(binding({ credentialGeneration: 2 })), response().accessToken)
        assert.equal(h.exchanges.length, boundary === 'initial-load' ? 1 : 2)
      } else await rejected(h.client.getAccessToken(binding()), expected)
    })
  }
}

test('an old flight finally cannot detach a newer generation flight', async (t) => {
  const h = harness(t)
  const oldGate = deferred()
  const newGate = deferred()
  h.provider = async (scope) => {
    if (scope.credentialGeneration === 1) await oldGate.promise
    else if (h.loads.length === 2) await newGate.promise
    return credential(scope)
  }
  h.client.activate(binding())
  const old = observe(h.client.getAccessToken(binding()))
  await flush()
  const next = binding({ credentialGeneration: 2 })
  h.client.activate(next)
  const a = h.client.getAccessToken(next)
  await flush()
  oldGate.resolve()
  await failed(old, 'GENERATION_MISMATCH')
  await flush()
  const b = h.client.getAccessToken(next)
  await flush()
  assert.equal(h.loads.length, 2, 'new caller must join the existing new-generation flight')
  newGate.resolve()
  await Promise.all([a, b])
  assert.equal(h.exchanges.length, 1)
})

test('synchronous abort listeners cannot make an outer rotation overwrite a newer generation', async (t) => {
  const h = harness(t)
  const gate = deferred()
  const latest = binding({ credentialGeneration: 3 })
  h.provider = async (scope, { signal }) => {
    if (scope.credentialGeneration === 1) {
      signal.addEventListener('abort', () => h.client.activate(latest), { once: true })
      await gate.promise
    }
    return credential(scope)
  }
  h.client.activate(binding())
  const old = observe(h.client.getAccessToken(binding()))
  try {
    await flush()
    h.client.activate(binding({ credentialGeneration: 2 }))
    await failed(old, 'GENERATION_MISMATCH')
    const newest = await observe(h.client.getAccessToken(latest))
    assert.equal(newest.value, response().accessToken, 'a newer activation from an abort listener must stay current')
    await rejected(h.client.getAccessToken(binding({ credentialGeneration: 2 })), 'GENERATION_MISMATCH')
  } finally { gate.resolve() }
  await flush()
})

test('one waiter cancellation does not abort a shared refresh or expose its reason', async (t) => {
  const h = harness(t)
  const gate = deferred()
  h.exchange = async () => { await gate.promise; return response() }
  h.client.activate(binding())
  const controller = new AbortController()
  const cancelled = observe(h.client.getAccessToken(binding(), { signal: controller.signal }))
  const remaining = h.client.getAccessToken(binding())
  await flush()
  controller.abort(new Error('synthetic-private-caller-reason'))
  await timely(failed(cancelled, 'CANCELLED'))
  assert.equal(h.exchanges[0].signal.aborted, false)
  gate.resolve()
  assert.equal(await remaining, response().accessToken)
  assert.equal(h.exchanges.length, 1)
})

test('last waiter cancellation keeps ignored underlying work charged against the flight limit', async (t) => {
  const h = harness(t, { maxOutstandingFlights: 1 })
  const gate = deferred()
  h.provider = async (scope) => { if (h.loads.length === 1) await gate.promise; return credential(scope) }
  h.client.activate(binding())
  const controller = new AbortController()
  const first = observe(h.client.getAccessToken(binding(), { signal: controller.signal }))
  await flush()
  controller.abort('synthetic-private-reason')
  await timely(failed(first, 'CANCELLED'))
  assert.equal(h.loads[0].signal.aborted, true)
  const other = binding({ ownerId: 'synthetic-owner-b' })
  h.client.activate(other)
  await rejected(h.client.getAccessToken(other), 'FLIGHT_LIMIT')
  assert.equal(h.loads.length, 1)
  gate.resolve()
  await flush()
  assert.equal(h.exchanges.length, 0)
  assert.equal(await h.client.getAccessToken(other), response().accessToken)
})

test('rotation cannot evade outstanding capacity while an old dependency ignores cancellation', async (t) => {
  const h = harness(t, { maxOutstandingFlights: 1 })
  const gate = deferred()
  h.exchange = async () => { if (h.exchanges.length === 1) await gate.promise; return response() }
  h.client.activate(binding())
  const old = observe(h.client.getAccessToken(binding()))
  await flush()
  const newer = binding({ credentialGeneration: 2 })
  h.client.activate(newer)
  await failed(old, 'GENERATION_MISMATCH')
  await rejected(h.client.getAccessToken(newer), 'FLIGHT_LIMIT')
  gate.resolve()
  await flush()
  assert.equal(await h.client.getAccessToken(newer), response().accessToken)
  assert.equal(h.exchanges.length, 2)
})

test('pre-aborted callers create no work and waiter overflow leaves admitted callers intact', async (t) => {
  const h = harness(t, { maxWaitersPerFlight: 2 })
  const gate = deferred()
  h.provider = async (scope) => { if (h.loads.length === 1) await gate.promise; return credential(scope) }
  h.client.activate(binding())
  const controller = new AbortController()
  controller.abort('synthetic-private-reason')
  await rejected(h.client.getAccessToken(binding(), { signal: controller.signal }), 'CANCELLED')
  assert.equal(h.loads.length, 0)
  const a = h.client.getAccessToken(binding())
  const b = h.client.getAccessToken(binding())
  await rejected(h.client.getAccessToken(binding()), 'WAITER_LIMIT')
  gate.resolve()
  assert.deepEqual(await Promise.all([a, b]), [response().accessToken, response().accessToken])
  assert.equal(h.exchanges.length, 1)
})

test('revocation tombstones consume bounded binding capacity and cannot be evicted to admit another identity', async (t) => {
  const h = harness(t, { maxBindings: 1 })
  h.client.activate(binding())
  h.client.revoke(binding())
  assert.throws(() => h.client.activate(binding({ ownerId: 'synthetic-owner-b' })), (error) => fixedError(error, 'BINDING_LIMIT'))
  assert.throws(() => h.client.activate(binding()), (error) => fixedError(error, 'REVOKED'))
  const next = binding({ credentialGeneration: 2 })
  h.client.activate(next)
  assert.equal(await h.client.getAccessToken(next), response().accessToken)
})

test('refresh timeout covers each provider/exchange stage and drains ignored work before freeing capacity', async (t) => {
  for (const stage of ['initial', 'exchange', 'final']) {
    const h = harness(t, { refreshTimeoutMs: 10, maxOutstandingFlights: 1 })
    const gate = deferred()
    h.provider = async (scope) => {
      if ((stage === 'initial' && h.loads.length === 1) || (stage === 'final' && h.loads.length === 2)) await gate.promise
      return credential(scope)
    }
    h.exchange = async () => { if (stage === 'exchange') await gate.promise; return response() }
    h.client.activate(binding())
    await timely(rejected(h.client.getAccessToken(binding()), 'TIMEOUT'))
    assert.equal(h.loads[0].signal.aborted, true)
    const other = binding({ ownerId: 'synthetic-owner-b' })
    h.client.activate(other)
    await rejected(h.client.getAccessToken(other), 'FLIGHT_LIMIT')
    gate.resolve()
    await flush()
    assert.equal(await h.client.getAccessToken(other), response().accessToken)
  }
})

test('TTL starts when exchange begins and is never extended to a minimum cache period', async (t) => {
  const h = harness(t, { safetySkewMs: 100 })
  h.client.activate(binding())
  h.exchange = async () => { h.now += 900; return response({ expireIn: 1 }) }
  await rejected(h.client.getAccessToken(binding()), 'EXPIRED')
  h.exchange = async () => response({ expireIn: 1 })
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  const before = h.exchanges.length
  h.now += 899
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  assert.equal(h.exchanges.length, before)
  h.now += 1
  assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
  assert.equal(h.exchanges.length, before + 1)
})

test('token expiry during the final provider check prevents publication', async (t) => {
  const h = harness(t)
  h.client.activate(binding())
  h.exchange = async () => response({ expireIn: 1 })
  h.provider = async (scope) => { if (h.loads.length === 2) h.now = 1000; return credential(scope) }
  await rejected(h.client.getAccessToken(binding()), 'EXPIRED')
})

test('token publication never succeeds at or after its actual expiry across advancing clock schedules', async (t) => {
  let successes = 0
  let expirations = 0
  for (const step of [1, 25, 50, 100, 150, 200, 250, 300, 400, 500]) {
    let latestClock = 0
    let exchangeStartedAt
    const h = harness(t, { monotonicNow: () => { latestClock += step; return latestClock } })
    h.exchange = async () => {
      exchangeStartedAt = latestClock
      return response({ expireIn: 1 })
    }
    h.client.activate(binding())
    const result = await observe(h.client.getAccessToken(binding()))
    assert.equal(typeof exchangeStartedAt, 'number', 'positive control must reach the actual exchange')
    if (Object.hasOwn(result, 'error')) {
      fixedError(result.error, 'EXPIRED')
      expirations += 1
    } else {
      assert.equal(result.value, response().accessToken)
      assert.ok(latestClock < exchangeStartedAt + 1000, 'no waiter may receive a token once its actual TTL has elapsed')
      successes += 1
    }
  }
  assert.ok(successes > 0, 'small clock steps must exercise successful publication')
  assert.ok(expirations > 0, 'large clock steps must exercise expiry rejection')
})

test('revocation from a synchronous clock callback during the final validation cannot publish a token', async (t) => {
  let revokeOnRead = false
  let clockRevocations = 0
  const h = harness(t, { monotonicNow: () => {
    if (revokeOnRead) {
      revokeOnRead = false
      clockRevocations += 1
      h.client.revoke(binding())
    }
    return 0
  } })
  h.provider = async (scope) => {
    if (h.loads.length === 2) revokeOnRead = true
    return credential(scope)
  }
  h.client.activate(binding())
  await rejected(h.client.getAccessToken(binding()), 'REVOKED')
  assert.equal(h.exchanges.length, 1)
  assert.equal(clockRevocations, 1)
  await rejected(h.client.getAccessToken(binding()), 'REVOKED')
})

test('invalid or backward clocks reject and remove a previously valid cache', async (t) => {
  for (const bad of [-1, NaN, Infinity, '10', 9]) {
    const h = harness(t)
    h.now = 10
    h.client.activate(binding())
    await h.client.getAccessToken(binding())
    h.now = bad
    await rejected(h.client.getAccessToken(binding()), 'CLOCK_INVALID')
    h.now = 11
    assert.equal(await h.client.getAccessToken(binding()), response().accessToken)
    assert.equal(h.exchanges.length, 2)
  }
})

test('provider results require exact own-data binding and bounded credential fields', async (t) => {
  const patches = [
    { tenantId: 'synthetic-other' }, { workspaceId: 'synthetic-other' }, { ownerId: 'synthetic-other' },
    { credentialRef: 'synthetic-other' }, { credentialGeneration: 2 },
    { appKey: '' }, { appKey: '   ' }, { appKey: 'a'.repeat(4097) }, { appSecret: '' },
    { appSecret: '   ' }, { appSecret: 'a'.repeat(4097) }, { appSecret: 123 }, { verified: true },
  ]
  for (const patch of patches) {
    const h = harness(t)
    h.client.activate(binding())
    h.provider = async (scope) => credential(scope, patch)
    await rejected(h.client.getAccessToken(binding()), 'CREDENTIAL_FAILED')
    assert.equal(h.exchanges.length, 0)
  }
  for (const kind of ['missing', 'accessor', 'inherited']) {
    const h = harness(t)
    let getterCalls = 0
    h.provider = async (scope) => {
      const value = credential(scope)
      if (kind === 'missing') delete value.workspaceId
      if (kind === 'accessor') Object.defineProperty(value, 'appSecret', { get() { getterCalls += 1; return 'synthetic-private-secret' } })
      return kind === 'inherited' ? Object.assign(Object.create({ inherited: true }), value) : value
    }
    h.client.activate(binding())
    await rejected(h.client.getAccessToken(binding()), 'CREDENTIAL_FAILED')
    assert.equal(getterCalls, 0)
    assert.equal(h.exchanges.length, 0)
  }
})

test('valid credential material preserves leading/trailing spaces instead of changing the secret', async (t) => {
  const h = harness(t)
  h.provider = async (scope) => credential(scope, { appKey: ' synthetic-key ', appSecret: ' synthetic-secret ' })
  h.client.activate(binding())
  await h.client.getAccessToken(binding())
  assert.deepEqual(h.exchanges[0].material, { appKey: ' synthetic-key ', appSecret: ' synthetic-secret ' })
})

test('exchange results use the exact protocol shape and never guess a TTL', async (t) => {
  const invalid = [
    { accessToken: 'synthetic-private-token' }, { expireIn: 60 }, response({ accessToken: '' }),
    response({ accessToken: ' token' }), response({ accessToken: 'token\n' }),
    response({ accessToken: 'a'.repeat(8193) }), response({ expireIn: 0 }), response({ expireIn: 86401 }),
    response({ expireIn: 1.5 }), response({ expireIn: '60' }), response({ expireIn: NaN }),
    { ...response(), verified: true }, { ...response(), expiresIn: 60 }, null,
  ]
  for (const value of invalid) {
    const h = harness(t)
    h.exchange = async () => value
    h.client.activate(binding())
    await rejected(h.client.getAccessToken(binding()), 'INVALID_RESPONSE')
    assert.equal(h.exchanges.length, 1)
  }
  let getters = 0
  const h = harness(t)
  h.exchange = async () => Object.defineProperty(response(), 'accessToken', { get() { getters += 1; return 'synthetic-private-token' } })
  h.client.activate(binding())
  await rejected(h.client.getAccessToken(binding()), 'INVALID_RESPONSE')
  assert.equal(getters, 0)
})

test('dependency rejection is sanitized and never automatically retried', async (t) => {
  for (const dependency of ['provider', 'exchange']) {
    const h = harness(t)
    h[dependency] = async () => { throw Object.assign(new Error('synthetic-private-token-and-secret'), { cause: new Error('synthetic-private-cause'), body: 'synthetic-private-body' }) }
    h.client.activate(binding())
    await rejected(h.client.getAccessToken(binding()), dependency === 'provider' ? 'CREDENTIAL_FAILED' : 'EXCHANGE_FAILED')
    assert.equal(h.loads.length, 1)
    assert.equal(h.exchanges.length, dependency === 'provider' ? 0 : 1)
  }
})

test('binding, option, signal and constructor validation reject unknown/accessor/inherited data', async (t) => {
  const h = harness(t)
  const missing = binding()
  delete missing.workspaceId
  const invalid = [missing, binding({ workspaceId: undefined }), binding({ workspaceId: '' }),
    binding({ ownerId: ' ' }), binding({ tenantId: 'a\n' }), binding({ credentialRef: 'a'.repeat(129) }),
    binding({ credentialGeneration: 0 }), binding({ credentialGeneration: 2147483648 }),
    binding({ credentialGeneration: '1' }), binding({ verified: true }), null, [],
    Object.assign(Object.create({ inherited: true }), binding())]
  let getters = 0
  invalid.push(Object.defineProperty(binding(), 'ownerId', { get() { getters += 1; return 'synthetic-owner-a' } }))
  for (const value of invalid) {
    assert.throws(() => h.client.activate(value), (error) => fixedError(error, 'INVALID_INPUT'))
    assert.throws(() => h.client.revoke(value), (error) => fixedError(error, 'INVALID_INPUT'))
    await rejected(h.client.getAccessToken(value), 'INVALID_INPUT')
  }
  h.client.activate(binding())
  for (const option of [{ signal: {} }, { signal: null }, { extra: true }, null, []]) {
    await rejected(h.client.getAccessToken(binding(), option), 'INVALID_INPUT')
  }
  assert.equal(getters, 0)
  assert.equal(h.loads.length, 0)
  const valid = { loadCredential: async (scope) => credential(scope), exchangeToken: async () => response() }
  for (const patch of [
    { loadCredential: null }, { exchangeToken: null }, { maxBindings: 0 }, { maxBindings: 257 },
    { maxOutstandingFlights: 0 }, { maxOutstandingFlights: 65 },
    { maxWaitersPerFlight: 0 }, { maxWaitersPerFlight: 257 },
    { refreshTimeoutMs: 9 }, { refreshTimeoutMs: 60001 }, { safetySkewMs: -1 }, { safetySkewMs: 120001 },
    { monotonicNow: null }, { arbitrary: true },
  ]) assert.throws(() => createYidaTokenClient({ ...valid, ...patch }), (error) => fixedError(error, 'INVALID_INPUT'))
  assert.throws(() => createYidaTokenClient(), (error) => fixedError(error, 'INVALID_INPUT'))
})

test('proxy and inherited native signals are rejected before traps or dependencies can run', async (t) => {
  const h = harness(t)
  h.client.activate(binding())
  let traps = 0
  const native = new AbortController().signal
  const proxy = new Proxy(native, { get(target, key) {
    traps += 1
    if (traps > 2) throw new Error('synthetic-private-proxy-error')
    return Reflect.get(target, key, target)
  } })
  await rejected(h.client.getAccessToken(binding(), { signal: proxy }), 'INVALID_INPUT')
  await rejected(h.client.getAccessToken(binding(), { signal: Object.create(native) }), 'INVALID_INPUT')
  assert.equal(traps, 0)
  assert.equal(h.loads.length, 0)
})

for (const phase of ['load', 'exchange', 'post-exchange-load']) {
  test(`disposeAndDrain preserves actual ${phase} work after the token waiter has cancelled`, async (t) => {
    const h = harness(t), gate = deferred(), control = new AbortController(), one = binding()
    let entered = false, drains = false
    h.provider = async scope => {
      if (phase === 'load' || (phase === 'post-exchange-load' && h.loads.length === 2)) {
        entered = true; await gate.promise
      }
      return credential(scope)
    }
    h.exchange = async () => {
      if (phase === 'exchange') { entered = true; await gate.promise }
      return response()
    }
    h.client.activate(one)
    const waiter = observe(h.client.getAccessToken(one, { signal: control.signal }))
    try {
      for (let turn = 0; turn < 30 && !entered; turn++) await flush()
      assert.equal(entered, true, 'the actual flight must reach the held dependency')
      control.abort()
      await timely(failed(waiter, 'CANCELLED'))
      const drain = h.client.disposeAndDrain()
      assert.equal(h.client.disposeAndDrain(), drain, 'one original drain promise')
      drain.then(() => { drains = true })
      await flush()
      assert.equal(drains, false, 'waiter rejection is not original flight completion')
      assert.throws(() => h.client.activate(one), error => fixedError(error, 'DISPOSED'))
      gate.resolve()
      await timely(drain)
      assert.equal(drains, true)
      assert.equal(h.exchanges.length, phase === 'load' ? 0 : 1)
      await rejected(h.client.getAccessToken(one), 'DISPOSED')
    } finally { gate.resolve(); await h.client.disposeAndDrain() }
  })
}

test('dispose is permanent, idempotent and exposes no cache or credential enumeration', async (t) => {
  const h = harness(t)
  h.client.activate(binding())
  await h.client.getAccessToken(binding())
  assert.deepEqual(Object.keys(h.client).sort(), ['activate', 'dispose', 'disposeAndDrain', 'getAccessToken', 'revoke'])
  h.client.dispose()
  h.client.dispose()
  await rejected(h.client.getAccessToken(binding()), 'DISPOSED')
  assert.throws(() => h.client.activate(binding()), (error) => fixedError(error, 'DISPOSED'))
  assert.throws(() => h.client.revoke(binding()), (error) => fixedError(error, 'DISPOSED'))
})

test('actual lifecycle and fixed exchange compose through a real streamed Response with exact credentials', async (t) => {
  const { createDingTalkAppTokenExchange } = require('../lib/yida-token-exchange.cjs')
  const requests = []
  const wireToken = 'synthetic-private-wire-token'
  const exchangeToken = createDingTalkAppTokenExchange({ fetch: async (url, options) => {
    requests.push({ url, options })
    const bytes = new TextEncoder().encode(JSON.stringify({ accessToken: wireToken, expireIn: 60, ignored: 'synthetic-private-ignored' }))
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 11))
        controller.enqueue(bytes.subarray(11))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const h = harness(t, { exchangeToken })
  h.client.activate(binding())
  assert.equal(await h.client.getAccessToken(binding()), wireToken)
  assert.equal(await h.client.getAccessToken(binding()), wireToken)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.dingtalk.com/v1.0/oauth2/accessToken')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.redirect, 'error')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(requests[0].options.body), { appKey: credential(binding()).appKey, appSecret: credential(binding()).appSecret })
  assert.equal(h.loads.length, 3)
})

test('actual exchange redirect and malformed TTL responses cannot become lifecycle token success', async (t) => {
  const { createDingTalkAppTokenExchange } = require('../lib/yida-token-exchange.cjs')
  for (const mode of ['redirect', 'missing-ttl']) {
    let requests = 0
    const exchangeToken = createDingTalkAppTokenExchange({ fetch: async () => {
      requests += 1
      return mode === 'redirect'
        ? new Response('synthetic-private-upstream-body', { status: 302, headers: { location: 'https://invalid.example/synthetic-private-path' } })
        : new Response(JSON.stringify({ accessToken: 'synthetic-private-wire-token' }), { status: 200 })
    } })
    const h = harness(t, { exchangeToken })
    h.client.activate(binding())
    await rejected(h.client.getAccessToken(binding()), 'EXCHANGE_FAILED')
    assert.equal(requests, 1)
    assert.equal(h.loads.length, 1, 'failed exchange cannot proceed to final publication validation')
  }
})

test('actual exchange with abort-ignoring fetch stays outstanding until raw fetch truly settles', async (t) => {
  const { createDingTalkAppTokenExchange } = require('../lib/yida-token-exchange.cjs')
  const fetchGate = deferred()
  const reached = deferred()
  let requests = 0
  let firstSignal
  const exchangeToken = createDingTalkAppTokenExchange({ fetch: async (_url, options) => {
    requests += 1
    if (requests === 1) {
      firstSignal = options.signal
      reached.resolve()
      await fetchGate.promise
    }
    return new Response(JSON.stringify(response({ accessToken: `synthetic-private-wire-token-${requests}` })), { status: 200 })
  } })
  const h = harness(t, { exchangeToken, maxOutstandingFlights: 1 })
  h.client.activate(binding())
  const controller = new AbortController()
  const first = observe(h.client.getAccessToken(binding(), { signal: controller.signal }))
  await timely(reached.promise)
  controller.abort('synthetic-private-abort-reason')
  await timely(failed(first, 'CANCELLED'))
  assert.equal(firstSignal.aborted, true)
  const other = binding({ ownerId: 'synthetic-owner-b' })
  h.client.activate(other)
  await rejected(h.client.getAccessToken(other), 'FLIGHT_LIMIT')
  assert.equal(requests, 1)
  fetchGate.resolve()
  await flush()
  assert.equal(h.loads.length, 1, 'late aborted fetch cannot reach post-exchange provider')
  assert.equal(await h.client.getAccessToken(other), 'synthetic-private-wire-token-2')
  assert.equal(requests, 2)
})

test('both token suites are exact executable entries in the production test chain', () => {
  const { loadChain, toArgv } = require('../scripts/test-chain.cjs')
  const commands = loadChain()
  for (const name of ['yida-token-client', 'yida-token-exchange']) {
    const expected = `node __tests__/${name}.test.cjs`
    assert.equal(commands.filter((command) => command === expected).length, 1)
    assert.deepEqual(toArgv(expected), [`__tests__/${name}.test.cjs`])
  }
})
