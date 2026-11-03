'use strict'

// Pure closed-input/control tests only. Never use these dependencies as proof
// of live host authority. The real PG suite uses actual core/090/091/runner.
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const native = new Function('url', 'return import(url)')
const modulePromise = native(pathToFileURL(path.resolve(__dirname, '../lib/yida-owner-send-port.mjs')).href)
const scope = () => ({ tenantId: 'test-tenant', workspaceId: null, ownerId: 'test-owner', actorId: 'test-owner' })
const request = () => ({ grantId: 'test-grant', submissionId: 'test-submission' })
function dependencies(patch = {}) {
  const calls = { admit: 0, take: 0, observe: 0, fetch: 0 }
  return { calls, options: { db: {}, context: scope(), authority: {
    async admitForExecution() { calls.admit++; throw new Error('DEPENDENCY_PRIVATE_DETAIL') },
    takeExecution() { calls.take++; throw new Error('DEPENDENCY_PRIVATE_DETAIL') },
    async observe() { calls.observe++; throw new Error('DEPENDENCY_PRIVATE_DETAIL') },
  }, fetch() { calls.fetch++; throw new Error('NETWORK_MUST_NOT_START') }, ...patch } }
}
function fixed(code) {
  return error => {
    assert.equal(error.code, 'YIDA_OWNER_SEND_' + code)
    assert.equal(error.message, error.code)
    assert.equal(error.name, 'YidaOwnerSendError')
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal('cause' in error, false)
    return true
  }
}
test('requires explicit fetch, tenant-null scope and owner identity; never falls back to global fetch', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  const { calls, options } = dependencies(), { fetch: _fetch, ...missingFetch } = options
  assert.throws(() => createYidaOwnerSendPort(missingFetch), fixed('INPUT'))
  for (const context of [{ ...scope(), workspaceId: 'workspace' }, { ...scope(), actorId: 'foreign' }])
    assert.throws(() => createYidaOwnerSendPort({ ...options, context }), fixed('INPUT'))
  assert.deepEqual(calls, { admit: 0, take: 0, observe: 0, fetch: 0 })
})
test('default OFF and non-literal enablement never even request an admission', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  const { calls, options } = dependencies()
  await assert.rejects(createYidaOwnerSendPort(options).submit(request()), fixed('DISABLED'))
  for (const value of [true, 1, 'TRUE', ' true', 'true ', undefined, null, 'false'])
    await assert.rejects(createYidaOwnerSendPort({ ...options, readEnablement: () => value }).submit(request()), fixed('DISABLED'))
  assert.deepEqual(calls, { admit: 0, take: 0, observe: 0, fetch: 0 })
})
test('closed input rejects caller payload/authority/scope and control accessors without invoking them', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  const { calls, options } = dependencies({ readEnablement: () => 'true' }), port = createYidaOwnerSendPort(options)
  for (const key of ['ownerId', 'tenantId', 'permit', 'isAdmin', 'payload', 'url', 'credential'])
    await assert.rejects(port.submit({ ...request(), [key]: true }), fixed('INPUT'))
  let getters = 0
  const accessor = request(); Object.defineProperty(accessor, 'grantId', { enumerable: true, get() { getters++; return 'test-grant' } })
  await assert.rejects(port.submit(accessor), fixed('INPUT'))
  await assert.rejects(port.submit(new Proxy(request(), { ownKeys() { getters++; return [] } })), fixed('INPUT'))
  await assert.rejects(port.submit(request(), { signal: {}, extra: true }), fixed('INPUT'))
  await assert.rejects(port.inspect({ grantId: 'test-grant', payload: true }), fixed('INPUT'))
  assert.equal(getters, 0); assert.deepEqual(calls, { admit: 0, take: 0, observe: 0, fetch: 0 })
})
test('already aborted native signal consumes no admission and starts no dependency IO', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  const { calls, options } = dependencies({ readEnablement: () => 'true' }), controller = new AbortController()
  controller.abort()
  await assert.rejects(createYidaOwnerSendPort(options).submit(request(), { signal: controller.signal }), fixed('CANCELLED'))
  assert.deepEqual(calls, { admit: 0, take: 0, observe: 0, fetch: 0 })
})
test('foreign rejection/proxy never leaks or invokes exception inspection traps', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  let traps = 0
  const foreign = new Proxy({}, { get() { traps++; throw new Error('PRIVATE_GETTER') }, getPrototypeOf() { traps++; throw new Error('PRIVATE_PROTOTYPE') } })
  const { calls, options } = dependencies({ readEnablement: () => 'true' })
  options.authority.admitForExecution = async () => { calls.admit++; throw foreign }
  options.authority.observe = async () => { calls.observe++; throw foreign }
  const port = createYidaOwnerSendPort(options)
  await assert.rejects(port.submit(request()), fixed('UNAVAILABLE'))
  await assert.rejects(port.inspect({ grantId: 'test-grant' }), fixed('UNAVAILABLE'))
  assert.equal(traps, 0); assert.equal(calls.fetch, 0); assert.equal(calls.take, 0)
})
test('ordinary rejected promise is not enablement and does not leak an unhandled rejection', async () => {
  const { createYidaOwnerSendPort } = await modulePromise
  const { calls, options } = dependencies({ readEnablement: () => Promise.reject(new Error('PRIVATE_ASYNC_CONTROL')) })
  await assert.rejects(createYidaOwnerSendPort(options).submit(request()), fixed('DISABLED'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, { admit: 0, take: 0, observe: 0, fetch: 0 })
})
test('fixed error constructor clamps unknown codes without reading foreign properties', async () => {
  const { YidaOwnerSendError } = await modulePromise
  let traps = 0
  const foreign = new Proxy({}, { get() { traps++; throw new Error('PRIVATE_PROPERTY') } })
  assert(fixed('UNAVAILABLE')(new YidaOwnerSendError(foreign)))
  assert.equal(traps, 0)
})
