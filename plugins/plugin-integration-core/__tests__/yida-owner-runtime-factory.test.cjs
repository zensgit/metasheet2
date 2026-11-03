'use strict'

// These are construction and refusal controls over the real imported modules.
// Dependency stubs only throw; none mint an approval, permit or successful send.
// Live actor ACL, transaction and authority evidence belongs to the real PG suite.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createDb } = require('../lib/db.cjs')
const native = new Function('url', 'return import(url)')
const modulePath = path.resolve(__dirname, '../lib/yida-owner-runtime-factory.mjs')
const modulePromise = native(pathToFileURL(modulePath).href)
const scope = () => ({ actorId: 'control-owner', tenantId: 'control-tenant', workspaceId: null })
const primitiveKeys = ['resolveSelectionInTransaction', 'executionPayloadDigest', 'prepareInTransaction',
  'loadExecutionMaterialInTransaction', 'previewInTransaction', 'prepareDraftInTransaction']

function dependencies() {
  const calls = { query: 0, transaction: 0, encrypt: 0, decrypt: 0, fetch: 0, admit: 0, take: 0, observe: 0 }
  const db = createDb({ database: {
    async query() { calls.query++; throw new Error('CONTROL_DATABASE_MUST_NOT_START') },
    async transaction() { calls.transaction++; throw new Error('CONTROL_TRANSACTION_MUST_NOT_START') },
  } })
  const security = {
    async encrypt() { calls.encrypt++; throw new Error('CONTROL_SECURITY_MUST_NOT_START') },
    async decrypt() { calls.decrypt++; throw new Error('CONTROL_SECURITY_MUST_NOT_START') },
    extraHostMethod() { throw new Error('CONTROL_EXTRA_MUST_NOT_RUN') },
  }
  const authority = {
    async admitForExecution() { calls.admit++; throw new Error('CONTROL_AUTHORITY_UNAVAILABLE') },
    takeExecution() { calls.take++; throw new Error('CONTROL_AUTHORITY_UNAVAILABLE') },
    async observe() { calls.observe++; throw new Error('CONTROL_AUTHORITY_UNAVAILABLE') },
    extraHostMethod() { throw new Error('CONTROL_EXTRA_MUST_NOT_RUN') },
  }
  const fetch = () => { calls.fetch++; throw new Error('CONTROL_NETWORK_MUST_NOT_START') }
  return { calls, options: { db, security }, send: { context: scope(), authority, fetch, readEnablement: () => 'false', timeoutMs: 10000 } }
}
function fixed(code, prefix = 'YIDA_OWNER_RUNTIME_', name = 'YidaOwnerRuntimeError') {
  return error => {
    assert.equal(error.code, prefix + code)
    assert.equal(error.message, error.code)
    assert.equal(error.name, name)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal(Object.hasOwn(error, 'cause'), false)
    return true
  }
}
function reject(action) { assert.throws(action, fixed('INPUT')) }
function noIO(calls) { assert.equal(Object.values(calls).every(value => value === 0), true) }
function accessor(object, key, count) {
  Object.defineProperty(object, key, { enumerable: true, get() { count.value++; return 'CONTROL_GETTER' } })
  return object
}
function hostileProxy(value, count) {
  return new Proxy(value, {
    ownKeys() { count.value++; throw new Error('CONTROL_PROXY') },
    getPrototypeOf() { count.value++; throw new Error('CONTROL_PROXY') },
    getOwnPropertyDescriptor() { count.value++; throw new Error('CONTROL_PROXY') },
    get() { count.value++; throw new Error('CONTROL_PROXY') },
    apply() { count.value++; throw new Error('CONTROL_PROXY') },
  })
}

test('control: real modules expose only frozen binding, primitives and disabled send port', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), binding = create(f.options), input = scope()
  assert.deepEqual(Object.keys(binding).sort(), ['createPrimitives', 'createSendPort'])
  assert.equal(Object.isFrozen(binding), true)
  for (const key of Object.keys(binding)) assert.equal(typeof binding[key], 'function')
  const primitives = binding.createPrimitives(input)
  assert.deepEqual(Object.keys(primitives).sort(), primitiveKeys.sort())
  assert.equal(Object.isFrozen(primitives), true)
  for (const key of primitiveKeys) assert.equal(typeof primitives[key], 'function')
  const port = binding.createSendPort(f.send)
  assert.deepEqual(Object.keys(port).sort(), ['inspect', 'submit'])
  assert.equal(Object.isFrozen(port), true)
  await assert.rejects(port.submit({ grantId: 'control-grant', submissionId: 'control-submission' }),
    fixed('DISABLED', 'YIDA_OWNER_SEND_', 'YidaOwnerSendError'))
  noIO(f.calls)
})

test('control: real primitives bind owner to actor and retain original context without starting a transaction', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), input = scope(), primitives = create(f.options).createPrimitives(input)
  input.actorId = 'changed-owner'; input.tenantId = 'changed-tenant'; input.workspaceId = 'changed-workspace'
  const prepared = { tenantId: 'control-tenant', workspaceId: null, ownerId: 'control-owner',
    operationId: 'control-operation', rowKey: 'control-row', targetRef: 'control-target',
    targetRevision: 'evidence-1', planRevision: 'control-plan', payloadDigest: '0'.repeat(64),
    businessKeyDigest: '0'.repeat(64), credentialRef: 'control-credential', credentialGeneration: 1, intent: 'create' }
  await assert.rejects(primitives.prepareInTransaction(null, { ...prepared, ownerId: 'foreign-owner' }),
    fixed('CONFLICT', 'YIDA_SEND_AUTHORITY_', 'YidaSendAuthorityError'))
  await assert.rejects(primitives.prepareInTransaction(null, prepared),
    fixed('UNAVAILABLE', 'YIDA_SEND_AUTHORITY_', 'YidaSendAuthorityError'))
  noIO(f.calls)
})

test('factory rejects malformed outer options, host DB and security before dependency IO', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies()
  for (const value of [undefined, null, true, 'private', [], { ...f.options, extra: true },
    { security: f.options.security }, { db: f.options.db }, Object.assign(Object.create({ inherited: true }), f.options)])
    reject(() => create(value))
  for (const key of ['db', 'security']) {
    for (const value of [undefined, null, 1, [], () => {}, {}]) reject(() => create({ ...f.options, [key]: value }))
  }
  for (const [key, method] of [['db', 'transaction'], ['db', 'selectOne'], ['security', 'encrypt'], ['security', 'decrypt']]) {
    const value = { ...f.options[key] }; delete value[method]
    reject(() => create({ ...f.options, [key]: value }))
    reject(() => create({ ...f.options, [key]: { ...f.options[key], [method]: true } }))
    reject(() => create({ ...f.options, [key]: Object.create(f.options[key]) }))
  }
  noIO(f.calls)
})

test('exact context rejects owner and permission injection, non-null workspace and malformed identifiers', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), binding = create(f.options)
  for (const value of [undefined, null, [], { actorId: 'control-owner', tenantId: 'control-tenant' },
    ...['ownerId', 'permission', 'isAdmin', 'payload'].map(key => ({ ...scope(), [key]: true })),
    ...['', 'workspace', undefined, 0].map(workspaceId => ({ ...scope(), workspaceId }))]) {
    reject(() => binding.createPrimitives(value))
    reject(() => binding.createSendPort({ ...f.send, context: value }))
  }
  for (const key of ['actorId', 'tenantId']) {
    for (const value of [undefined, null, 1, '', ' ', ' owner', 'owner ', 'x'.repeat(129), 'line\nfeed', 'delete\u007f']) {
      reject(() => binding.createPrimitives({ ...scope(), [key]: value }))
      reject(() => binding.createSendPort({ ...f.send, context: { ...scope(), [key]: value } }))
    }
  }
  noIO(f.calls)
})

test('send options require explicit fetch, enablement, timeout and authority data functions and reject host dependency overrides', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), binding = create(f.options)
  for (const key of ['context', 'authority', 'fetch', 'readEnablement', 'timeoutMs']) {
    const missing = { ...f.send }; delete missing[key]
    reject(() => binding.createSendPort(missing))
  }
  for (const key of ['db', 'security', 'ownerId', 'tenantId', 'permit', 'permission', 'payload', 'url'])
    reject(() => binding.createSendPort({ ...f.send, [key]: true }))
  for (const authority of [undefined, null, [], {}, Object.create(f.send.authority)])
    reject(() => binding.createSendPort({ ...f.send, authority }))
  for (const key of ['admitForExecution', 'takeExecution', 'observe']) {
    const authority = { ...f.send.authority }; delete authority[key]
    reject(() => binding.createSendPort({ ...f.send, authority }))
    reject(() => binding.createSendPort({ ...f.send, authority: { ...f.send.authority, [key]: true } }))
  }
  for (const value of [undefined, null, true, {}, 'true']) {
    reject(() => binding.createSendPort({ ...f.send, fetch: value }))
    reject(() => binding.createSendPort({ ...f.send, readEnablement: value }))
  }
  for (const timeoutMs of [undefined, null, '10000', 0, 9, 60001, 100.5, NaN, Infinity])
    reject(() => binding.createSendPort({ ...f.send, timeoutMs }))
  noIO(f.calls)
})

test('all exposed records and consumed dependencies reject getters and proxies without running traps', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), count = { value: 0 }, binding = create(f.options)
  const outerAccessor = accessor({ ...f.options }, 'db', count)
  reject(() => create(outerAccessor))
  reject(() => create(hostileProxy(f.options, count)))
  for (const key of ['db', 'security']) {
    reject(() => create({ ...f.options, [key]: hostileProxy(f.options[key], count) }))
    for (const method of key === 'db' ? ['transaction', 'selectOne'] : ['encrypt', 'decrypt']) {
      reject(() => create({ ...f.options, [key]: accessor({ ...f.options[key] }, method, count) }))
      reject(() => create({ ...f.options, [key]: { ...f.options[key], [method]: hostileProxy(() => {}, count) } }))
    }
  }
  for (const key of ['actorId', 'tenantId', 'workspaceId']) {
    reject(() => binding.createPrimitives(accessor(scope(), key, count)))
    reject(() => binding.createSendPort({ ...f.send, context: accessor(scope(), key, count) }))
  }
  reject(() => binding.createPrimitives(hostileProxy(scope(), count)))
  reject(() => binding.createSendPort(hostileProxy(f.send, count)))
  reject(() => binding.createSendPort({ ...f.send, context: hostileProxy(scope(), count) }))
  reject(() => binding.createSendPort({ ...f.send, authority: hostileProxy(f.send.authority, count) }))
  for (const key of ['admitForExecution', 'takeExecution', 'observe'])
    reject(() => binding.createSendPort({ ...f.send, authority: accessor({ ...f.send.authority }, key, count) }))
  for (const key of ['context', 'authority', 'fetch', 'readEnablement', 'timeoutMs'])
    reject(() => binding.createSendPort(accessor({ ...f.send }, key, count)))
  for (const key of ['fetch', 'readEnablement'])
    reject(() => binding.createSendPort({ ...f.send, [key]: hostileProxy(() => {}, count) }))
  assert.equal(count.value, 0)
  noIO(f.calls)
})

test('exact record shape rejects symbols, non-enumerable fields and inherited records', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), binding = create(f.options)
  for (const [input, action] of [[f.options, value => create(value)], [scope(), value => binding.createPrimitives(value)],
    [f.send, value => binding.createSendPort(value)]]) {
    reject(() => action({ ...input, [Symbol('unexpected')]: true }))
    reject(() => action(Object.assign(Object.create({ inherited: true }), input)))
    for (const key of Object.keys(input)) {
      const nonEnumerable = { ...input }
      Object.defineProperty(nonEnumerable, key, { value: input[key], enumerable: false })
      reject(() => action(nonEnumerable))
    }
  }
  const nullOptions = Object.assign(Object.create(null), f.options)
  assert.equal(Object.isFrozen(create(nullOptions).createPrimitives(Object.assign(Object.create(null), scope()))), true)
  noIO(f.calls)
})

test('control: actual port inspection closes rejecting authority and snapshots method identity', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await modulePromise
  const f = dependencies(), port = create(f.options).createSendPort(f.send)
  let replacements = 0
  f.send.authority.observe = async () => { replacements++; throw new Error('CONTROL_REPLACEMENT') }
  await assert.rejects(port.inspect({ grantId: 'control-grant' }),
    fixed('UNAVAILABLE', 'YIDA_OWNER_SEND_', 'YidaOwnerSendError'))
  assert.equal(replacements, 0)
  assert.equal(f.calls.observe, 1)
  assert.equal(Object.entries(f.calls).filter(([key]) => key !== 'observe').every(([, value]) => value === 0), true)
})

async function mutant(label, from, to) {
  const source = fs.readFileSync(modulePath, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(source.split(from).length, 2, label + ': unique mutation anchor required')
  const changed = source.replace(from, to)
  assert.notEqual(changed, source)
  // Only the factory source is varied. Relative imports resolve to the exact
  // real dependency modules; no replacement module, loader fake or disk edit.
  const absolute = changed.replace(/from '(\.\/[^']+)'/g, (_match, relative) =>
    "from '" + pathToFileURL(path.resolve(path.dirname(modulePath), relative)).href + "'")
  return (await native('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'))).createYidaOwnerRuntimeBinding
}
const mutationCases = [
  {
    label: 'M-record-proxy-object',
    from: "  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()\n  const prototype",
    to: '  const prototype',
    check(create) {
      const f = dependencies(), count = { value: 0 }
      reject(() => create(hostileProxy(f.options, count)))
      assert.equal(count.value, 0)
    },
  },
  {
    label: 'M-record-prototype',
    from: '  if (prototype !== Object.prototype && prototype !== null) fail()\n', to: '',
    check(create) { const f = dependencies(); reject(() => create(Object.assign(Object.create({ inherited: true }), f.options))) },
  },
  {
    label: 'M-record-keyset',
    from: "  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))\n    || keys.some(key => !Object.hasOwn(properties, key))) fail()\n", to: '',
    check(create) { const f = dependencies(); reject(() => create({ ...f.options, permission: true })) },
  },
  {
    label: 'M-record-data-enumerability',
    from: "    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail()\n", to: '',
    check(create) {
      const f = dependencies(), options = { ...f.options }
      Object.defineProperty(options, 'db', { value: f.options.db, enumerable: false })
      reject(() => create(options))
    },
  },
  {
    label: 'M-callable-function-proxy',
    from: "  if (typeof value !== 'function' || types.isProxy(value)) fail()\n", to: '',
    check(create) {
      const f = dependencies(), count = { value: 0 }
      reject(() => create({ ...f.options, security: { ...f.options.security, encrypt: hostileProxy(() => {}, count) } }))
      assert.equal(count.value, 0)
    },
  },
  {
    label: 'M-capability-proxy-object',
    from: "  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()\n  const result",
    to: '  const result',
    check(create) {
      const f = dependencies(), count = { value: 0 }
      reject(() => create({ ...f.options, db: hostileProxy(f.options.db, count) }))
      assert.equal(count.value, 0)
    },
  },
  {
    label: 'M-capability-own-data-method',
    from: "    if (!property || !Object.hasOwn(property, 'value')) fail()\n", to: '',
    check(create) { const f = dependencies(); reject(() => create({ ...f.options, db: {} })) },
  },
  {
    label: 'M-id-domain',
    from: "  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value\n    || /[\\u0000-\\u001f\\u007f]/u.test(value)) fail()\n", to: '',
    check(create) { const f = dependencies(); reject(() => create(f.options).createPrimitives({ ...scope(), actorId: '' })) },
  },
  {
    label: 'M-tenant-null-workspace',
    from: '  if (parsed.workspaceId !== null) fail()\n', to: '',
    check(create) { const f = dependencies(); reject(() => create(f.options).createPrimitives({ ...scope(), workspaceId: 'foreign-workspace' })) },
  },
  {
    label: 'M-timeout-bounds',
    from: '        if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 10 || config.timeoutMs > 60000) fail()\n', to: '',
    check(create) { const f = dependencies(); reject(() => create(f.options).createSendPort({ ...f.send, timeoutMs: 9 })) },
  },
  {
    label: 'M-own-error-preservation',
    from: '  if (ownErrors.has(error)) throw error\n', to: '',
    check(create) { reject(() => create(null)) },
  },
]
for (const probe of mutationCases) {
  test('in-memory guard mutation is killed: ' + probe.label, async t => {
    const { createYidaOwnerRuntimeBinding: create } = await modulePromise
    probe.check(create)
    const changed = await mutant(probe.label, probe.from, probe.to)
    assert.throws(() => probe.check(changed), { name: 'AssertionError' })
    t.diagnostic(probe.label + ': intact PASS; guard removed => AssertionError (RED); no disk mutation')
  })
}
