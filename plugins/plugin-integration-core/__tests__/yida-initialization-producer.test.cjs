'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const native = new Function('url', 'return import(url)')
const modulePath = path.resolve(__dirname, '../lib/yida-initialization-producer.mjs')
const modules = Promise.all([modulePath, path.resolve(__dirname, '../lib/yida-static-plan.mjs')].map(file => native(pathToFileURL(file).href)))
const actor = () => ({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const material = () => ({ appKey: ' synthetic-key\t', appSecret: '\nsynthetic-secret ', systemToken: ' synthetic-system ', userId: 'synthetic-executor' })
const attestation = () => ({ kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' })
const commandId = '11111111-1111-4111-8111-111111111111'
async function input() {
  const [, planner] = await modules, example = planner.createYidaProtocolExample()
  return { commandId, material: material(), draft: { config: example.config, rowsText: example.text, allocation: { mode: 'original' } }, attestation: attestation() }
}
function fixed(code) { return error => { assert.equal(error.message, 'YIDA_INITIALIZATION_PRODUCER_' + code); assert.equal(error.code, error.message); assert.equal(Object.hasOwn(error, 'cause'), false); return true } }
async function mutatedProducer(anchor, replacement) {
  const source = fs.readFileSync(modulePath, 'utf8'), directory = path.dirname(modulePath)
  assert.equal(source.split(anchor).length, 2)
  const mutant = source.replace(anchor, replacement)
    .replace(/from '(\.\/[^']+)'/gu, (_all, relative) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(directory, relative)).href))
  return native('data:text/javascript;base64,' + Buffer.from(mutant).toString('base64'))
}
function fixture() {
  const rows = new Map(), statements = [], fault = { table: null }
  const security = { async encrypt(value) { return 'enc:' + Buffer.from(value).toString('base64') }, async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() } }
  // Synthetic SQL sink, not transaction/ACL evidence. The real shared stores and
  // actual db.cjs generate every statement; real PG proof is a separate suite.
  const raw = { async query(sql, params = []) {
    statements.push(sql)
    assert(!/^(BEGIN|SET|COMMIT|ROLLBACK)\b/u.test(sql))
    const table = /(?:FROM|INTO) "([a-z_]+)"/u.exec(sql)?.[1]
    assert(table && table.startsWith('integration_'))
    const current = rows.get(table) ?? []; rows.set(table, current)
    if (sql.startsWith('INSERT')) {
      if (fault.table === table) throw new Error('PRIVATE_DRIVER_CANARY')
      const names = [.../\(([^)]+)\) VALUES/u.exec(sql)[1].matchAll(/"([a-z_]+)"/gu)].map(match => match[1])
      const row = Object.fromEntries(names.map((name, index) => [name, params[index]]))
      current.push(structuredClone(row)); return { rows: [structuredClone(row)], rowCount: 1 }
    }
    assert(sql.startsWith('SELECT'))
    const where = / WHERE (.*?)(?: ORDER BY| LIMIT| FOR UPDATE|$)/u.exec(sql)?.[1]
    let found = current.filter(row => !where || where.split(' AND ').every(part => {
      const equal = /"([a-z_]+)" = \$(\d+)/u.exec(part)
      const nil = /"([a-z_]+)" IS NULL/u.exec(part)
      assert(equal || nil)
      return equal ? row[equal[1]] === params[Number(equal[2]) - 1] : row[nil[1]] === null
    }))
    if (/ORDER BY "ordinal"/u.test(sql)) found = [...found].sort((a, b) => a.ordinal - b.ordinal)
    const limit = / LIMIT (\d+)/u.exec(sql)
    if (limit) found = found.slice(0, Number(limit[1]))
    return { rows: structuredClone(found), rowCount: found.length }
  } }
  return { raw, rows, statements, fault, security }
}
test('private binding and producer are closed, actor-bound and inert at construction', async () => {
  const [{ createYidaInitializationBinding }] = await modules, f = fixture(), context = actor()
  const binding = createYidaInitializationBinding({ security: f.security }), producer = binding.createInitializationProducer(context)
  assert.deepEqual(Object.keys(binding), ['createInitializationProducer'])
  assert.deepEqual(Object.keys(producer), ['initializeInTransaction', 'inspectDraftInTransaction'])
  assert(Object.isFrozen(binding) && Object.isFrozen(producer))
  assert.equal(f.statements.length, 0)
  assert.throws(() => createYidaInitializationBinding({ security: f.security, db: {} }), fixed('INPUT'))
  assert.throws(() => binding.createInitializationProducer({ ...actor(), ownerId: 'forged' }), fixed('INPUT'))
  assert.throws(() => binding.createInitializationProducer({ ...actor(), workspaceId: 'forged' }), fixed('INPUT'))
})
test('real three writers use only actual db.cjs CRUD and inspect real persisted replay', async () => {
  const [{ createYidaInitializationBinding }] = await modules, f = fixture(), context = actor(), request = await input()
  const producer = createYidaInitializationBinding({ security: f.security }).createInitializationProducer(context)
  context.actorId = 'changed-owner'; context.tenantId = 'changed-tenant'
  const made = await producer.initializeInTransaction(f.raw, request)
  assert.deepEqual(Object.keys(made).sort(), ['credentialGeneration', 'credentialRef', 'draft', 'targetRef'])
  assert.equal(made.credentialGeneration, 1); assert.equal(made.draft.status, 'unverified')
  assert.equal(made.draft.canSend, false); assert.equal(made.draft.tokenIssued, false)
  assert.equal(made.draft.externalWriteAttempted, false)
  assert.equal(f.rows.get('integration_yida_credential_materials').length, 1)
  assert.equal(f.rows.get('integration_yida_approved_target').length, 1)
  const stored = f.rows.get('integration_yida_credential_materials')[0]
  assert.equal(stored.owner_id, 'synthetic-owner'); assert.equal(stored.tenant_id, 'synthetic-tenant')
  assert.deepEqual(JSON.parse(await f.security.decrypt(stored.material_encrypted)).material, request.material)
  const inspected = await producer.inspectDraftInTransaction(f.raw, { operationId: made.draft.operationId })
  assert.deepEqual(inspected, { ...made.draft, reused: true })
  const output = JSON.stringify([made, inspected])
  for (const secret of Object.values(request.material)) assert.equal(output.includes(secret), false)
  assert.equal(f.statements.some(sql => /integration_yida_(send_|delivery_|create_fence)/u.test(sql)), false)
})
test('closed input rejects forged scope, recovery extras and invalid material before SQL', async () => {
  const [{ createYidaInitializationBinding }] = await modules, f = fixture()
  const producer = createYidaInitializationBinding({ security: f.security }).createInitializationProducer(actor())
  const request = await input()
  for (const bad of [{ ...request, ownerId: 'forged' }, { ...request, material: { ...request.material, token: 'forged' } },
    { ...request, material: { ...request.material, appKey: ' ' } }, { ...request, commandId: 'not-uuid' }]) {
    await assert.rejects(producer.initializeInTransaction(f.raw, bad), fixed('INPUT'))
  }
  await assert.rejects(producer.inspectDraftInTransaction(f.raw, { operationId: commandId, ownerId: 'forged' }), fixed('INPUT'))
  assert.equal(f.statements.length, 0)
})
test('accessor/proxy context and foreign driver errors cannot project private bytes', async () => {
  const [{ createYidaInitializationBinding }] = await modules, f = fixture(), binding = createYidaInitializationBinding({ security: f.security })
  let reads = 0
  const context = actor(); Object.defineProperty(context, 'actorId', { enumerable: true, get() { reads++; return 'PRIVATE_GETTER_CANARY' } })
  assert.throws(() => binding.createInitializationProducer(context), fixed('INPUT')); assert.equal(reads, 0)
  const proxy = new Proxy(actor(), { ownKeys() { reads++; throw new Error('PRIVATE_PROXY_CANARY') } })
  assert.throws(() => binding.createInitializationProducer(proxy), fixed('INPUT')); assert.equal(reads, 0)
  const producer = binding.createInitializationProducer(actor()), request = await input()
  await assert.rejects(producer.initializeInTransaction({ async query() { throw new Error('PRIVATE_DRIVER_CANARY') } }, request), fixed('UNAVAILABLE'))
})
test('real material guard removal lets the same forbidden extra field reach the writer (red mutant)', async () => {
  const [{ createYidaInitializationBinding: original }] = await modules
  const { createYidaInitializationBinding } = await mutatedProducer("['appKey', 'appSecret', 'systemToken', 'userId']",
    "['appKey', 'appSecret', 'systemToken', 'userId', 'forged']")
  const f = fixture(), request = await input(); request.material.forged = 'PRIVATE_EXTRA_CANARY'
  await assert.rejects(original({ security: f.security }).createInitializationProducer(actor()).initializeInTransaction(f.raw, request), fixed('INPUT'))
  assert.equal(f.statements.length, 0)
  await assert.rejects(createYidaInitializationBinding({ security: f.security }).createInitializationProducer(actor()).initializeInTransaction(f.raw, request), fixed('UNAVAILABLE'))
  // The original rejects INPUT before any writer; this mutant reaches the real
  // 090 guard instead, so the original INPUT/no-writer assurance fails.
})
test('identity is exact raw material userId before 090; removing this guard initializes the forbidden mismatch', async () => {
  const [{ createYidaInitializationBinding }] = await modules, request = await input(), f = fixture()
  const producer = createYidaInitializationBinding({ security: f.security }).createInitializationProducer(actor())
  const wrong = { ...request, attestation: { ...request.attestation, executionIdentity: 'synthetic-other-executor' } }
  await assert.rejects(producer.initializeInTransaction(f.raw, wrong), fixed('INPUT'))
  const padded = { ...request, material: { ...request.material, userId: ' ' + request.material.userId + ' ' } }
  await assert.rejects(producer.initializeInTransaction(f.raw, padded), fixed('INPUT'))
  assert.equal(f.statements.length, 0)
  // Legal compiler input and scope stay identical; only the actual identity
  // guard is removed. The old shared 090/092 contracts remain unchanged.
  const mutant = await mutatedProducer('  if (attestation.executionIdentity !== material.userId) fail()', '')
  const made = await mutant.createYidaInitializationBinding({ security: f.security }).createInitializationProducer(actor()).initializeInTransaction(f.raw, wrong)
  assert.equal(made.credentialGeneration, 1)
  assert.equal(f.rows.get('integration_yida_approved_target').length, 1)
  assert.throws(() => assert.equal(f.statements.length, 0), assert.AssertionError)
})
function pluginContext(services, config) {
  const namespaces = new Map(), routes = [], calls = []
  return { namespaces, routes, calls, context: {
    api: { http: { addRoute(method, path, handler) { routes.push({ method, path, handler }) } },
      database: { async query(sql) { calls.push(sql); return [] } } },
    communication: { register(name, api) { namespaces.set(name, api) }, call: async () => {}, on() {}, emit() {} },
    storage: { async get() { return null }, async set() {} },
    logger: { info() {}, warn() {}, error() {} }, config: { b2aTrialRegistry: { registryId: 'synthetic-registry', registryVersion: 1, registrations: [] }, ...config },
    services: { security: fixture().security, ...services },
  } }
}
async function bounded(promise, phase) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SYNTHETIC_LIFECYCLE_' + phase)), 2000) })]) }
  finally { clearTimeout(timer) }
}
test('actual plugin lifecycle keeps initialization private and latches stop before owner drain', async () => {
  const plugin = require('../index.cjs'), flag = require('../lib/sealed-export/stock-preparation-runtime-config.cjs').FEATURE_FLAG, previous = process.env[flag]
  process.env[flag] = 'false'
  let release, binding
  const drain = new Promise(resolve => { release = resolve }), events = []
  const f = pluginContext({
    yidaInitializationRuntime: { async activate(value) { binding = value; return { stop() { events.push('init-stop'); return drain } } } },
    yidaOwnerRuntime: { async activate() { return { async stop() { events.push('owner-stop') } } } },
  })
  try {
    await bounded(plugin.activate(f.context), 'ACTIVATE')
    assert.deepEqual(Object.keys(binding), ['createInitializationProducer'])
    assert.equal(f.namespaces.size, 1)
    assert.equal(Object.keys(f.namespaces.get('integration-core')).some(key => /initialization/iu.test(key)), false)
    assert.equal(f.routes.some(route => /initialization/iu.test(route.path)), false)
    const stopped = plugin.deactivate()
    assert.deepEqual(events, ['init-stop', 'owner-stop'])
    let done = false; stopped.then(() => { done = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false)
    release(); await bounded(stopped, 'DRAIN')
  } finally { release?.(); await bounded(plugin.deactivate(), 'CLEANUP'); if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous }
})
test('actual plugin initialization activation refusal remains fixed and owner capability drains on deactivation', async () => {
  const plugin = require('../index.cjs'), flag = require('../lib/sealed-export/stock-preparation-runtime-config.cjs').FEATURE_FLAG, previous = process.env[flag]
  process.env[flag] = 'false'
  let stopped = 0
  const f = pluginContext({
    yidaOwnerRuntime: { async activate() { return { async stop() { stopped++ } } } },
    yidaInitializationRuntime: { async activate() { throw new Error('SYNTHETIC_PRIVATE_DETAIL') } },
  })
  try {
    await assert.rejects(bounded(plugin.activate(f.context), 'ACTIVATE'), { message: 'YIDA_INITIALIZATION_RUNTIME_UNAVAILABLE' })
    assert.equal(stopped, 0)
    await plugin.deactivate(); assert.equal(stopped, 1)
  } finally { await plugin.deactivate(); if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous }
})
