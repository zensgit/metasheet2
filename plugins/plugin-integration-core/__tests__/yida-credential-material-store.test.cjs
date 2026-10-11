'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const yaml = require('js-yaml')
const ts = require('typescript')
const { createYidaCredentialMaterialStore, createInternalYidaCredentialTransactionWriter } = require('../lib/yida-credential-material-store.cjs')

const HEAD = 'integration_yida_credential_materials'
const AUDIT = 'integration_yida_credential_audit'
const context = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' }
const bundle = () => ({ appKey: ' synthetic-app ', appSecret: ' synthetic-secret ',
  systemToken: ' synthetic-system ', userId: ' synthetic-user ' })
const binding = ({ status: _status, ...rest }) => rest
const reject = (promise, suffix) => assert.rejects(promise, error => {
  assert.equal(error.code, 'YIDA_CREDENTIAL_' + suffix)
  assert.equal(error.message, error.code)
  assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
  return true
})

// A transactional unit fake, not encryption/SQL/concurrency evidence. The
// separate realDB suite uses actual host security, db.cjs and PG sessions.
function fixture(fixed = context) {
  let rows = { [HEAD]: [], [AUDIT]: [] }
  const faults = { audit: false, lostCommit: false }
  const calls = []
  const db = { async transaction(callback) {
    const staged = structuredClone(rows)
    let isolated = false
    const query = (method, table, where) => {
      assert.equal(isolated, true)
      calls.push({ method, table, where: structuredClone(where) })
    }
    const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
    const result = await callback({
      async setTransactionIsolationLevel(value) { assert.equal(value, 'read committed'); isolated = true },
      async selectOneForUpdate(table, where) {
        query('lock', table, where)
        return structuredClone(staged[table].find(row => matches(row, where)) ?? null)
      },
      async insertOne(table, row) {
        query('insert', table, {})
        if (table === AUDIT && faults.audit) throw new Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL')
        staged[table].push(structuredClone(row))
        return { rows: [structuredClone(row)] }
      },
      async updateRow(table, set, where) {
        query('update', table, where)
        const row = staged[table].find(entry => matches(entry, where))
        if (!row) return []
        Object.assign(row, structuredClone(set))
        return [structuredClone(row)]
      },
    })
    rows = staged
    if (faults.lostCommit) { faults.lostCommit = false; throw new Error('SYNTHETIC_COMMIT_REPLY_LOST') }
    return result
  } }
  const security = {
    async encrypt(value) { return 'enc:' + Buffer.from(value).toString('base64') },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() },
  }
  const fresh = (scope = fixed, vault = security) => createYidaCredentialMaterialStore({ db, security: vault, context: scope })
  return { db, security, fresh, store: fresh(), calls, faults,
    snapshot: () => structuredClone(rows), edit: mutate => mutate(rows[HEAD]),
    envelope: row => JSON.parse(Buffer.from(row.material_encrypted.slice(4), 'base64').toString()),
    setEnvelope: (row, value) => { row.material_encrypted = 'enc:' + Buffer.from(JSON.stringify(value)).toString('base64') },
  }
}

test('new suites run whole-file in real CI lanes, not in the no-DB lane', () => {
  const root = path.resolve(__dirname, '../../..')
  const spec = 'tests/integration/stock-preparation-yida-credential-materials-realdb.test.ts'
  const flow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8'))
  const step = flow.jobs.test.steps.find(item => item.id === 'external-system-delete-bind-lock-protocol-real-db')
  assert.equal(step.env.EXPECT_DB, '1')
  assert.equal(step.if, "matrix.node-version == '20.x'")
  assert.ok(step.env.DATABASE_URL)
  const command = step.run.replace(/\\\r?\n/g, ' ')
  assert.equal(command.split(/\s+/).filter(token => token === spec).length, 1)
  assert.doesNotMatch(command, /(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
  const source = ts.createSourceFile('vitest.config.ts', fs.readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const exclusions = []
  const walk = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      exclusions.push(...node.initializer.elements.filter(ts.isStringLiteral).map(item => item.text))
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  assert.equal(exclusions.includes(spec), true)
  const lines = fs.readFileSync(path.join(root, 'plugins/plugin-integration-core/test-chain.txt'), 'utf8').split(/\r?\n/)
  for (const name of ['yida-credential-material-store', 'yida-token-client', 'yida-token-exchange']) {
    assert.equal(lines.filter(line => line === `node __tests__/${name}.test.cjs`).length, 1)
  }
  assert.equal(lines.some(line => line.includes(spec)), false)
})

test('requires host security and explicit trusted context before any operation', () => {
  const f = fixture()
  for (const security of [undefined, null, {}, { encrypt() {} }]) {
    assert.throws(() => createYidaCredentialMaterialStore({ db: f.db, context, security }), { code: 'YIDA_CREDENTIAL_UNAVAILABLE' })
  }
  for (const value of [undefined, {}, { ...context, workspaceId: undefined }, { ...context, tenantId: '' }, { ...context, admin: true }]) {
    assert.throws(() => f.fresh(value === undefined ? {} : value), { code: 'YIDA_CREDENTIAL_INPUT' })
  }
  assert.equal(f.calls.length, 0)
})

test('server creates ref and initial generation, preserves bytes, returns only safe metadata/projection', async () => {
  const f = fixture(), material = bundle()
  assert.deepEqual(Object.keys(f.store).sort(), ['create', 'inspect', 'loadTokenCredential', 'revoke', 'rotate'])
  const made = await f.store.create({ material })
  assert.match(made.credentialRef, /^[0-9a-f-]{36}$/)
  assert.equal(made.credentialGeneration, 1)
  assert.equal(made.status, 'current')
  assert.equal(Object.isFrozen(made), true)
  assert.deepEqual(await f.store.inspect({ credentialRef: made.credentialRef }), made)
  const loaded = await f.fresh().loadTokenCredential(binding(made))
  assert.deepEqual(loaded, { ...binding(made), appKey: material.appKey, appSecret: material.appSecret })
  assert.equal(Object.isFrozen(loaded), true)
  assert.deepEqual(f.envelope(f.snapshot()[HEAD][0]).material, material)
  assert.equal(f.snapshot()[AUDIT].length, 1)
  assert.equal(JSON.stringify(made).includes('synthetic-secret'), false)
})

test('complete four-material generation is monotonic across ABA and all individual changes', async () => {
  const f = fixture(), original = bundle()
  let made = await f.store.create({ material: original })
  for (const key of Object.keys(original)) {
    const previous = made
    made = await f.store.rotate({ credentialRef: made.credentialRef, expectedGeneration: made.credentialGeneration,
      material: { ...original, [key]: original[key] + 'B' } })
    assert.equal(made.credentialGeneration, previous.credentialGeneration + 1)
    await reject(f.fresh().loadTokenCredential(binding(previous)), 'CONFLICT')
  }
  made = await f.store.rotate({ credentialRef: made.credentialRef, expectedGeneration: made.credentialGeneration, material: original })
  assert.equal(made.credentialGeneration, 6)
  assert.deepEqual(f.envelope(f.snapshot()[HEAD][0]).material, original)
  assert.equal(f.snapshot()[HEAD].length, 1)
  assert.equal(f.snapshot()[AUDIT].length, 6)
})

test('revoke erases ciphertext, is idempotent, and recovery requires higher generation', async () => {
  const f = fixture(), made = await f.store.create({ material: bundle() })
  const input = { credentialRef: made.credentialRef, expectedGeneration: 1 }
  const revoked = await f.store.revoke(input)
  assert.equal(revoked.status, 'revoked')
  assert.equal(f.snapshot()[HEAD][0].material_encrypted, null)
  assert.deepEqual(await f.fresh().revoke(input), revoked)
  assert.equal(f.snapshot()[AUDIT].length, 2)
  await reject(f.fresh().loadTokenCredential(binding(made)), 'REVOKED')
  const next = await f.store.rotate({ ...input, material: bundle() })
  assert.equal(next.credentialGeneration, 2)
  await reject(f.store.revoke(input), 'CONFLICT')
  await reject(f.store.loadTokenCredential(binding(made)), 'CONFLICT')
})

test('max generation cannot wrap but remains revocable', async () => {
  const f = fixture(), made = await f.store.create({ material: bundle() })
  f.edit(rows => { rows[0].generation = 2147483647 })
  const input = { credentialRef: made.credentialRef, expectedGeneration: 2147483647 }
  await reject(f.store.rotate({ ...input, material: bundle() }), 'CONFLICT')
  assert.equal((await f.store.revoke(input)).status, 'revoked')
})

test('no owner/admin bypass, cross tenant/workspace fallback or omitted workspace', async () => {
  const f = fixture(), made = await f.store.create({ material: bundle() })
  for (const patch of [{ ownerId: 'other-owner' }, { tenantId: 'other-tenant' }, { workspaceId: 'other-workspace' }]) {
    await reject(f.store.loadTokenCredential({ ...binding(made), ...patch }), 'NOT_FOUND')
    const other = f.fresh({ ...context, ...patch })
    await reject(other.inspect({ credentialRef: made.credentialRef }), 'NOT_FOUND')
    await reject(other.loadTokenCredential({ ...binding(made), ...patch }), 'NOT_FOUND')
    await reject(other.revoke({ credentialRef: made.credentialRef, expectedGeneration: 1 }), 'NOT_FOUND')
    await reject(other.rotate({ credentialRef: made.credentialRef, expectedGeneration: 1, material: bundle() }), 'NOT_FOUND')
  }
  const missing = binding(made); delete missing.workspaceId
  await reject(f.store.loadTokenCredential(missing), 'INPUT')
  assert.equal(f.snapshot()[AUDIT].length, 1)
})

test('envelope binds purpose/version/scope/ref/generation independently of outer row', async () => {
  for (const patch of [{ purpose: 'other' }, { schemaVersion: 2 }, { tenantId: 'other' }, { workspaceId: 'other' },
    { ownerId: 'other' }, { credentialRef: 'other' }, { credentialGeneration: 2 }, { extra: true }]) {
    const f = fixture(), made = await f.store.create({ material: bundle() })
    f.edit(rows => f.setEnvelope(rows[0], { ...f.envelope(rows[0]), ...patch }))
    await reject(f.store.loadTokenCredential(binding(made)), 'UNAVAILABLE')
  }
})

test('rejects plaintext and legacy before decrypt; never leaks underlying failures', async () => {
  for (const value of ['plaintext', 'v1:legacy', 'enc:', null]) {
    const f = fixture(), made = await f.store.create({ material: bundle() })
    f.edit(rows => { rows[0].material_encrypted = value })
    const guarded = f.fresh(context, { ...f.security, decrypt() { assert.fail('must reject before decrypt') } })
    await reject(guarded.loadTokenCredential(binding(made)), 'UNAVAILABLE')
  }
  for (const value of ['plaintext', 'v1:legacy', null]) {
    const f = fixture(), guarded = f.fresh(context, { ...f.security, async encrypt() { return value } })
    await reject(guarded.create({ material: bundle() }), 'UNAVAILABLE')
    assert.equal(f.snapshot()[HEAD].length, 0)
  }
  const f = fixture(), made = await f.store.create({ material: bundle() })
  const broken = f.fresh(context, { ...f.security, async decrypt() { throw new Error('SYNTHETIC_PRIVATE_CIPHER_DETAILS') } })
  await reject(broken.loadTokenCredential(binding(made)), 'UNAVAILABLE')
})

test('closed input rejects caller identity/generation, accessors, proxies and incomplete material without invocation', async () => {
  const f = fixture()
  let invoked = 0
  const accessor = { get material() { invoked++; return bundle() } }
  const proxy = new Proxy({ material: bundle() }, { getPrototypeOf() { invoked++; return Object.prototype } })
  for (const input of [accessor, proxy, { material: bundle(), credentialRef: 'caller' }, { material: bundle(), credentialGeneration: 1 },
    { material: { appKey: 'x' } }, { material: { ...bundle(), userId: 'x'.repeat(129) } },
    { material: { ...bundle(), systemToken: ' ' } }, { material: { ...bundle(), extra: 'x' } }]) {
    await reject(f.store.create(input), 'INPUT')
  }
  assert.equal(invoked, 0)
  assert.equal(f.calls.length, 0)
})

test('audit failure rolls back state; lost commit result fails closed without automatic retry', async () => {
  const f = fixture()
  f.faults.audit = true
  await reject(f.store.create({ material: bundle() }), 'UNAVAILABLE')
  assert.equal(f.snapshot()[HEAD].length, 0)
  f.faults.audit = false
  const made = await f.store.create({ material: bundle() })
  const before = f.snapshot()
  f.faults.audit = true
  await reject(f.store.rotate({ credentialRef: made.credentialRef, expectedGeneration: 1, material: bundle() }), 'UNAVAILABLE')
  await reject(f.store.revoke({ credentialRef: made.credentialRef, expectedGeneration: 1 }), 'UNAVAILABLE')
  assert.deepEqual(f.snapshot(), before)
  f.faults.audit = false; f.faults.lostCommit = true
  await reject(f.store.rotate({ credentialRef: made.credentialRef, expectedGeneration: 1, material: bundle() }), 'UNAVAILABLE')
  assert.equal((await f.store.inspect({ credentialRef: made.credentialRef })).credentialGeneration, 2)
  assert.equal(f.snapshot()[AUDIT].length, 2)
})

test('native cancellation before/after decrypt and malformed signal fail with fixed errors', async () => {
  const f = fixture(), made = await f.store.create({ material: bundle() })
  for (const signal of [null, 42, {}, new Proxy(new AbortController().signal, {})]) {
    await reject(f.store.loadTokenCredential(binding(made), { signal }), 'INPUT')
  }
  const controller = new AbortController()
  controller.abort(new Error('SYNTHETIC_PRIVATE_REASON'))
  await reject(f.store.loadTokenCredential(binding(made), { signal: controller.signal }), 'CANCELLED')
  const during = new AbortController()
  const late = f.fresh(context, { ...f.security, async decrypt(value) {
    during.abort(); return f.security.decrypt(value)
  } })
  await reject(late.loadTokenCredential(binding(made), { signal: during.signal }), 'CANCELLED')
})

test('private material writer shares actual create persistence in the caller transaction and preserves secret bytes', async () => {
  const f = fixture(), material = bundle()
  const writer = createInternalYidaCredentialTransactionWriter({ security: f.security, context })
  const made = await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    const value = await writer(trx, { material })
    assert.deepEqual(f.snapshot()[HEAD], []) // Outer commit has not happened.
    return value
  })
  assert.deepEqual(Object.keys(made).sort(), ['credentialGeneration', 'credentialRef', 'ownerId', 'status', 'tenantId', 'workspaceId'])
  assert.equal(Object.isFrozen(made), true)
  assert.deepEqual(f.envelope(f.snapshot()[HEAD][0]).material, material)
  assert.equal(f.snapshot()[AUDIT].length, 1)
  assert.deepEqual(await f.store.inspect({ credentialRef: made.credentialRef }), made)
  assert.throws(() => createInternalYidaCredentialTransactionWriter({ db: f.db, security: f.security, context }), { code: 'YIDA_CREDENTIAL_INPUT' })
  const before = f.snapshot()
  f.faults.audit = true
  await reject(f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    return writer(trx, { material })
  }), 'UNAVAILABLE')
  assert.deepEqual(f.snapshot(), before)
})

function materialWriterProbe(api = { createInternalYidaCredentialTransactionWriter }, patch = {}) {
  const writes = []
  const security = { async encrypt(text) { return 'enc:' + Buffer.from(text).toString('base64') }, async decrypt() { assert.fail('create does not decrypt') } }
  const trx = { async selectOneForUpdate() { assert.fail('create does not lock a preexisting material') }, async updateRow() { assert.fail('create never updates') },
    async insertOne(table, row) { writes.push(table); return [{ ...row, ...(table === HEAD ? patch : {}) }] } }
  return { writer: api.createInternalYidaCredentialTransactionWriter({ security, context }), trx, writes }
}
function materialMutation(from, to) {
  const filename = path.resolve(__dirname, '../lib/yida-credential-material-store.cjs')
  const source = fs.readFileSync(filename, 'utf8')
  assert.equal(source.split(from).length, 2, 'mutation must match exactly once')
  const memory = new Module(filename, module)
  memory.paths = Module._nodeModulePaths(path.dirname(filename))
  memory._compile(source.replace(from, to), filename)
  return memory.exports
}

test('private material writer rejects non-host handles, scope input and unknown exceptions without invoking foreign traps', async () => {
  const f = materialWriterProbe()
  let traps = 0
  const accessor = { ...f.trx }
  Object.defineProperty(accessor, 'insertOne', { get() { traps++; return f.trx.insertOne } })
  const proxied = new Proxy(f.trx, { get() { traps++; return undefined }, getOwnPropertyDescriptor() { traps++; return undefined } })
  for (const trx of [undefined, null, [], { query() {} }, Object.create(f.trx), accessor, proxied]) {
    await reject(f.writer(trx, { material: bundle() }), 'UNAVAILABLE')
  }
  for (const input of [{ material: bundle(), tenantId: context.tenantId }, { material: bundle(), ownerId: context.ownerId },
    { material: bundle(), credentialRef: 'caller-selected' }, { material: bundle(), credentialGeneration: 1 }]) {
    await reject(f.writer(f.trx, input), 'INPUT')
  }
  assert.equal(f.writes.length, 0); assert.equal(traps, 0)
  const hostile = new Proxy({}, { get() { traps++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') }, getPrototypeOf() { traps++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') } })
  for (const refusal of [null, 'SYNTHETIC_PRIVATE_DETAIL', hostile]) {
    await reject(f.writer({ ...f.trx, async insertOne() { throw refusal } }, { material: bundle() }), 'UNAVAILABLE')
  }
  assert.equal(traps, 0)
  for (const patch of [{ tenant_id: 'other' }, { workspace_id: 'other' }, { owner_id: 'other' }]) {
    const broken = materialWriterProbe(undefined, patch)
    await reject(broken.writer(broken.trx, { material: bundle() }), 'UNAVAILABLE')
    assert.deepEqual(broken.writes, [HEAD])
  }
})

test('memory mutations prove material host-handle, returned scope, closed input and error guards are necessary', async () => {
  const hostGuard = "    if (!trx || typeof trx !== 'object' || isProxy(trx) || Array.isArray(trx)\n      || ['selectOneForUpdate', 'insertOne', 'updateRow'].some(key => {\n        const property = Object.getOwnPropertyDescriptor(trx, key)\n        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'\n      })) fail('UNAVAILABLE')"
  const probe = materialWriterProbe(materialMutation(hostGuard, ''))
  await assert.rejects(() => reject(probe.writer(Object.create(probe.trx), { material: bundle() }), 'UNAVAILABLE'), assert.AssertionError)
  console.log('MUTATION material host-handle guard removed: baseline negative assertion RED (inherited handle accepted)')
  const scopeGuard = '      || row.tenant_id !== fixed.tenantId || row.workspace_id !== fixed.workspaceId\n      || row.owner_id !== fixed.ownerId'
  for (const [field, check] of [['tenant_id', 'row.tenant_id !== fixed.tenantId'], ['workspace_id', 'row.workspace_id !== fixed.workspaceId'], ['owner_id', 'row.owner_id !== fixed.ownerId']]) {
    const mutated = materialWriterProbe(materialMutation(scopeGuard, scopeGuard.replace(check, 'false')), { [field]: 'other' })
    await assert.rejects(() => reject(mutated.writer(mutated.trx, { material: bundle() }), 'UNAVAILABLE'), assert.AssertionError)
    console.log(`MUTATION material returned ${field} guard removed: baseline negative assertion RED (foreign scope accepted)`)
  }
  const inputProbe = materialWriterProbe(materialMutation("function createInput(input) { return material(record(input, ['material']).material) }", 'function createInput(input) { return material(input.material) }'))
  await assert.rejects(() => reject(inputProbe.writer(inputProbe.trx, { material: bundle(), ownerId: 'self-reported' }), 'INPUT'), assert.AssertionError)
  console.log('MUTATION material closed create input removed: baseline negative assertion RED (self-reported scope accepted)')
  const boundary = "      try { return await createInTransaction(trx, input) }\n      catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }"
  const unknown = materialWriterProbe(materialMutation(boundary, '      return createInTransaction(trx, input)'))
  await assert.rejects(() => reject(unknown.writer({ ...unknown.trx, async insertOne() { throw new Error('SYNTHETIC_PRIVATE_DETAIL') } }, { material: bundle() }), 'UNAVAILABLE'), assert.AssertionError)
  console.log('MUTATION material private error closure removed: baseline negative assertion RED (driver error escaped)')
  const factory = "    const parsed = record(options, ['security', 'context'])\n    return createCredentialInternals(parsed).createInTransaction"
  const open = materialMutation(factory, '    const parsed = options\n    return createCredentialInternals(parsed).createInTransaction'), f = fixture()
  assert.throws(() => assert.throws(() => open.createInternalYidaCredentialTransactionWriter({ db: f.db, security: f.security, context }), { code: 'YIDA_CREDENTIAL_INPUT' }), assert.AssertionError)
  console.log('MUTATION material private factory closed options removed: baseline negative assertion RED (db capability admitted)')
})
