'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createYidaConnectionProbeBinding, YidaConnectionProbeError } = require('../lib/yida-connection-probe.cjs')

// Every transport and credential here is synthetic and injected; no listener or network.
// The endpoint below is a literal written in this file on purpose (never imported from the
// exchange module), so a changed ENDPOINT constant in the exchange turns this suite red.
const DINGTALK_OAUTH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const credentials = () => ({ appKey: ' synthetic-probe-key ', appSecret: ' synthetic-probe-secret\n原字节 ' })
const tokenBody = () => JSON.stringify({ accessToken: 'synthetic-probe-access-token', expireIn: 7200 })

function harness(respond) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  const probe = createYidaConnectionProbeBinding().createConnectionProbe({ fetch })
  return { calls, probe }
}

test('binding is closed and frozen: exactly createConnectionProbe; probe exposes only probe()', () => {
  const binding = createYidaConnectionProbeBinding()
  assert.deepEqual(Object.keys(binding), ['createConnectionProbe'])
  assert.equal(Object.isFrozen(binding), true)
  const probe = binding.createConnectionProbe({ fetch: async () => new Response(tokenBody()) })
  assert.deepEqual(Object.keys(probe), ['probe'])
  assert.equal(Object.isFrozen(probe), true)
  for (const bad of [undefined, {}, { fetch: 'x' }, { fetch() {}, extra: 1 }, new Proxy({ fetch() {} }, {})]) {
    assert.throws(() => binding.createConnectionProbe(bad), YidaConnectionProbeError)
  }
})

test('200 with a valid token: ok, the record is exactly { outcome } and carries no token', async () => {
  const h = harness(() => new Response(tokenBody(), { status: 200 }))
  const result = await h.probe.probe(credentials(), { signal: new AbortController().signal })
  assert.deepEqual(Object.keys(result), ['outcome'])
  assert.equal(result.outcome, 'ok')
  assert.equal(Object.isFrozen(result), true)
  assert.equal(JSON.stringify(result).includes('synthetic-probe-access-token'), false)
  assert.equal(h.calls.length, 1)
  const [{ url, init }] = h.calls
  assert.equal(url, DINGTALK_OAUTH_ENDPOINT)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  const body = JSON.parse(init.body)
  assert.deepEqual(Object.keys(body), ['appKey', 'appSecret'])
  // Exact pasted bytes: never trimmed or normalized.
  assert.equal(body.appKey, credentials().appKey)
  assert.equal(body.appSecret, credentials().appSecret)
})

test('any answer without a valid token is upstream_rejected; the status is not distinguished', async () => {
  const samples = [
    () => new Response('{"code":"invalidClientId"}', { status: 400 }),
    () => new Response('{}', { status: 401 }),
    () => new Response('{}', { status: 403 }),
    () => new Response('{}', { status: 429 }),
    () => new Response('{}', { status: 500 }),
    () => new Response('{"errcode":40001,"errmsg":"synthetic"}', { status: 200 }),
    () => new Response('<html>synthetic proxy page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response(JSON.stringify({ accessToken: 'synthetic', expireIn: 0 }), { status: 200 }),
    () => new Response('x'.repeat(20 * 1024), { status: 200 }),
    () => new Response('{}', { status: 200, headers: { 'content-length': '999999' } }),
  ]
  for (const [index, sample] of samples.entries()) {
    const h = harness(sample)
    const result = await h.probe.probe(credentials(), { signal: new AbortController().signal })
    assert.deepEqual(result, { outcome: 'upstream_rejected' }, `sample ${index}`)
    assert.equal(h.calls.length, 1)
  }
})

test('a fetch that cannot connect or is redirected is unreachable', async () => {
  for (const failure of [new TypeError('fetch failed'), Object.assign(new Error('synthetic ENOTFOUND'), { code: 'ENOTFOUND' }),
    new TypeError('redirect mode is set to error')]) {
    const h = harness(() => { throw failure })
    assert.deepEqual(await h.probe.probe(credentials(), { signal: new AbortController().signal }), { outcome: 'unreachable' })
    assert.equal(h.calls.length, 1)
  }
})

test('caller abort is a cancellation, never an outcome (the host decides timeout vs abort)', async () => {
  const control = new AbortController()
  const h = harness((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }))
  const pending = h.probe.probe(credentials(), { signal: control.signal })
  control.abort()
  await assert.rejects(pending, (error) => error instanceof YidaConnectionProbeError && error.code === 'YIDA_CONNECTION_PROBE_CANCELLED')
  const aborted = new AbortController(); aborted.abort()
  const early = harness(() => new Response(tokenBody()))
  await assert.rejects(early.probe.probe(credentials(), { signal: aborted.signal }), { code: 'YIDA_CONNECTION_PROBE_CANCELLED' })
  assert.equal(early.calls.length, 0)
})

test('invalid material or options never reach fetch', async () => {
  const signal = new AbortController().signal
  const bad = [
    [{ appKey: '', appSecret: 'synthetic' }, { signal }],
    [{ appKey: '   ', appSecret: 'synthetic' }, { signal }],
    [{ appKey: 'synthetic', appSecret: 'x'.repeat(4097) }, { signal }],
    [{ appKey: 'synthetic', appSecret: 'synthetic', systemToken: 'synthetic' }, { signal }],
    [{ appKey: 'synthetic' }, { signal }],
    [credentials(), {}],
    [credentials(), { signal, extra: true }],
    [credentials(), { signal: { aborted: false, addEventListener() {} } }],
  ]
  for (const [index, [material, options]] of bad.entries()) {
    const h = harness(() => new Response(tokenBody()))
    await assert.rejects(h.probe.probe(material, options), (error) => error instanceof YidaConnectionProbeError
      && error.code === 'YIDA_CONNECTION_PROBE_UNAVAILABLE', `sample ${index}`)
    assert.equal(h.calls.length, 0, `sample ${index}`)
  }
})

test('errors carry no cause, body or credential bytes', async () => {
  const h = harness(() => { throw Object.assign(new Error('synthetic-private-transport-detail'), { cause: 'synthetic-private-cause' }) })
  const result = await h.probe.probe(credentials(), { signal: new AbortController().signal })
  assert.deepEqual(result, { outcome: 'unreachable' })
  const refused = harness(() => new Response(tokenBody()))
  try {
    await refused.probe.probe({ appKey: '', appSecret: 'synthetic-probe-secret' }, { signal: new AbortController().signal })
    assert.fail('expected refusal')
  } catch (error) {
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.doesNotMatch(String(error.stack), /synthetic-probe-secret|api\.dingtalk\.com/)
  }
})

// Actual plugin lifecycle: the third (connection-test) activation block fails SOFT. A missing,
// malformed or refusing capability leaves only 测试连接 inactive; the plugin and its other YiDa
// capabilities stay active. Synthetic context only.
function pluginContext(services) {
  const warnings = [], namespaces = new Map()
  const security = { async encrypt(value) { return 'enc:' + Buffer.from(value).toString('base64') }, async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() } }
  return { warnings, namespaces, context: {
    api: { http: { addRoute() {} }, database: { async query() { return [] } } },
    communication: { register(name, api) { namespaces.set(name, api) }, call: async () => {}, on() {}, emit() {} },
    storage: { async get() { return null }, async set() {} },
    logger: { info() {}, warn(message) { warnings.push(message) }, error() {} },
    config: { b2aTrialRegistry: { registryId: 'synthetic-registry', registryVersion: 1, registrations: [] } },
    services: { security, ...services },
  } }
}
async function bounded(promise, phase) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SYNTHETIC_LIFECYCLE_' + phase)), 2000) })]) }
  finally { clearTimeout(timer) }
}
async function withPlugin(services, check) {
  const plugin = require('../index.cjs'), flag = require('../lib/sealed-export/stock-preparation-runtime-config.cjs').FEATURE_FLAG, previous = process.env[flag]
  process.env[flag] = 'false'
  try { await check(plugin, pluginContext(services)) }
  finally { await bounded(plugin.deactivate(), 'CLEANUP'); if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous }
}

test('actual plugin hands the host exactly the probe binding and stops it on deactivation', async () => {
  let binding, stops = 0, initStops = 0
  await withPlugin({
    yidaInitializationRuntime: { async activate() { return { async stop() { initStops++ } } } },
    yidaConnectionTestRuntime: { async activate(value) { binding = value; return { async stop() { stops++ } } } },
  }, async (plugin, f) => {
    await bounded(plugin.activate(f.context), 'ACTIVATE')
    assert.deepEqual(Object.keys(binding), ['createConnectionProbe'])
    assert.equal(Object.isFrozen(binding), true)
    assert.equal(Object.keys(f.namespaces.get('integration-core')).some((key) => /connection|probe/iu.test(key) && /yida/iu.test(key)), false)
    assert.deepEqual(f.warnings.filter((line) => /YIDA_CONNECTION_TEST/u.test(line)), [])
    await bounded(plugin.deactivate(), 'DEACTIVATE')
    assert.equal(stops, 1); assert.equal(initStops, 1)
  })
})

test('a missing, malformed or refusing probe capability does not take down plugin activation', async () => {
  const variants = [
    null,
    {},
    { activate: 'synthetic-not-a-function' },
    { async activate() { throw new Error('SYNTHETIC_PRIVATE_DETAIL') } },
    { async activate() { return { stop: 'synthetic-not-a-function' } } },
  ]
  for (const [index, capability] of variants.entries()) {
    let initActivated = false
    await withPlugin({
      yidaInitializationRuntime: { async activate() { initActivated = true; return { async stop() {} } } },
      yidaConnectionTestRuntime: capability,
    }, async (plugin, f) => {
      await bounded(plugin.activate(f.context), 'ACTIVATE')
      assert.equal(initActivated, true, `variant ${index}`)
      assert.ok(f.namespaces.has('integration-core'), `variant ${index}`)
      const lines = f.warnings.filter((line) => /YIDA_CONNECTION_TEST/u.test(line))
      assert.deepEqual(lines, ['[plugin-integration-core] YIDA_CONNECTION_TEST_RUNTIME_INACTIVE'], `variant ${index}`)
      assert.doesNotMatch(lines.join('\n'), /SYNTHETIC_PRIVATE_DETAIL/u)
    })
  }
})
